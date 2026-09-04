"""Independent algorithm regression tests for the plugin runtime."""
import io, json, subprocess, tempfile, threading
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock
import numpy as np
from PIL import Image
import sys
ROOT=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(ROOT))
import advanced_bridge
import identity_engine, team_retouch
from team_retouch import bounded_planning_box, emit_progress, identify_people, match_returned_batch, maximize_assignment, plan_work_tiles, spatially_order_people
from patch_merge import align_patch, constrain_person_boundary, edit_weight_and_delta, fuse_patch_delta, merge

def main():
    stream=io.StringIO()
    with redirect_stdout(stream): emit_progress(34,'working')
    assert json.loads(stream.getvalue())['progress']==34
    ordered=spatially_order_people([{'box':[100,0,120,20]},{'box':[0,0,20,20]}]); assert ordered[0]['box'][0]==0
    crop=bounded_planning_box([10,10,30,40],[10,10,30,40],100,100); assert crop[0]<=10 and crop[2]>=30
    tiles=plan_work_tiles([{'box':[5,5,35,45]},{'box':[40,5,70,45]}],100,100); assert tiles and sorted(set(sum((tile['indices'] for tile in tiles),[])))==[0,1]
    assert maximize_assignment([[0.9,0.1],[0.2,0.8]])==[0,1]
    black=np.zeros((8,8),np.uint8); white=np.full((8,8),255,np.uint8)
    black_before=black.copy(); white_before=white.copy()
    assert team_retouch._normalized_correlation(black,white)==0.0
    assert np.array_equal(black,black_before) and np.array_equal(white,white_before), 'correlation must not mutate descriptors'
    assert team_retouch._perceptual_hash(np.zeros((32,32),np.uint8)).shape==(63,), 'pHash excludes only its DC coefficient'
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary); returned=root/'returned.png'; candidate=root/'candidate.png'; manifest=root/'returns.json'
        Image.new('RGB',(64,64),'black').save(returned); Image.new('RGB',(64,64),'white').save(candidate)
        manifest.write_text(json.dumps({'returned':[{'path':str(returned),'returnId':'r'}],'candidates':[{'patchPath':str(candidate),'taskId':'t'}]}),encoding='utf-8')
        with redirect_stdout(io.StringIO()): matched=match_returned_batch(str(manifest))
        assert matched['matches'][0]['confidence']!='high', 'constant black and white images must not auto-match at high confidence'
    with mock.patch.object(advanced_bridge, 'script_path', side_effect=lambda name: ROOT/'advanced'/name), \
         mock.patch.object(advanced_bridge, 'wsl_path', side_effect=lambda path: f"/mnt/c/{Path(path).name}"), \
         mock.patch.object(advanced_bridge, 'run_shell', side_effect=[subprocess.TimeoutExpired(['wsl.exe'], 12), '']) as run_shell:
        assert advanced_bridge.probe_advanced()==(True,'')
        assert [call.args[1] for call in run_shell.call_args_list]==[12,12]
    with mock.patch.object(advanced_bridge, 'script_path', side_effect=lambda name: ROOT/'advanced'/name), \
         mock.patch.object(advanced_bridge, 'wsl_path', side_effect=lambda path: f"/mnt/c/{Path(path).name}"), \
         mock.patch.object(advanced_bridge, 'run_shell', side_effect=RuntimeError('WSL_E_DISTRO_NOT_FOUND')) as run_shell:
        available,error=advanced_bridge.probe_advanced(); assert not available and 'WSL_E_DISTRO_NOT_FOUND' in error
        assert run_shell.call_count==1
    assert [path.name for path in sorted([Path('mask-100.png'),Path('mask-2.png'),Path('mask-11.png')],key=advanced_bridge._mask_sort_key)]==['mask-2.png','mask-11.png','mask-100.png']
    class FakeProcess:
        def __init__(self, stdout=None, stderr=None):
            self.stdin=io.BytesIO(); self.stdout=io.BytesIO(stdout if stdout is not None else b'{"type":"ready"}\n{"success":true,"value":7}\n'); self.stderr=io.BytesIO(stderr if stderr is not None else b'diagnostic-tail')
            self.returncode=None
        def poll(self): return self.returncode
        def wait(self,timeout=None): self.returncode=0; return 0
        def terminate(self): self.returncode=0
        def kill(self): self.returncode=-9
    burst=b''.join(f'diagnostic-{index}\n'.encode() for index in range(400))+b'{"type":"ready"}\n{"success":true,"value":7}\n'
    fake_process=FakeProcess(burst, b'x'*20000)
    with mock.patch.object(advanced_bridge,'distro_candidates',return_value=('FakeDistro',)), \
         mock.patch.object(advanced_bridge,'wsl_path',return_value='/component/service.py'), \
         mock.patch.object(advanced_bridge.subprocess,'Popen',return_value=fake_process):
        bridge=advanced_bridge._WslJsonService('/python',Path('service.py'))
        assert len(bridge.reader_threads)==2, 'one fixed reader per stdout/stderr is created for the process'
        assert bridge.request({'action':'test'},timeout=1)['value']==7
        readers=list(bridge.reader_threads)
        bridge.close()
        assert all(not worker.is_alive() for worker in readers), 'normal close joins both fixed reader threads'
    startup_process=FakeProcess(b'', b'startup-timeout')
    existing_reader_ids={worker.ident for worker in threading.enumerate() if worker.name.startswith('photoflow-wsl-')}
    with mock.patch.object(advanced_bridge,'distro_candidates',return_value=('FakeDistro',)), \
         mock.patch.object(advanced_bridge,'wsl_path',return_value='/component/service.py'), \
         mock.patch.object(advanced_bridge.subprocess,'Popen',return_value=startup_process), \
         mock.patch.object(advanced_bridge._WslJsonService,'_readline',side_effect=TimeoutError('startup')):
        try: advanced_bridge._WslJsonService('/python',Path('service.py'))
        except RuntimeError as error: assert 'startup timed out' in str(error)
        else: raise AssertionError('startup timeout must fail')
        assert all(worker.ident in existing_reader_ids for worker in threading.enumerate() if worker.name.startswith('photoflow-wsl-')), 'startup timeout leaves no reader thread alive'
    timeout_process=FakeProcess(b'{"type":"ready"}\n', b'request-timeout')
    with mock.patch.object(advanced_bridge,'distro_candidates',return_value=('FakeDistro',)), \
         mock.patch.object(advanced_bridge,'wsl_path',return_value='/component/service.py'), \
         mock.patch.object(advanced_bridge.subprocess,'Popen',return_value=timeout_process):
        bridge=advanced_bridge._WslJsonService('/python',Path('service.py')); readers=list(bridge.reader_threads)
        with mock.patch.object(bridge,'_readline',side_effect=TimeoutError('request')):
            try: bridge.request({'action':'timeout'},timeout=.01)
            except TimeoutError: pass
            else: raise AssertionError('request timeout must fail')
        assert all(not worker.is_alive() for worker in readers), 'request timeout closes streams and joins readers'
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary); base=root/'base.png'; patch=root/'patch.png'; mask=root/'mask.png'; output=root/'merged.tif'
        Image.new('RGB',(32,32),'black').save(base); Image.new('RGB',(8,8),'white').save(patch); Image.new('L',(16,16),255).save(mask)
        manifest=root/'merge.json'; manifest.write_text(json.dumps({'tasks':[{'id':'one','editedPatchPath':str(patch),'maskPath':str(mask),'crop':{'x':8,'y':8,'width':16,'height':16}}]}),encoding='utf-8')
        merged=merge(str(base),str(manifest),str(output))
        assert output.exists() and Image.open(output).size==(32,32)
        assert merged['metrics'][0]['resized'], 'different return dimensions must still be normalized to the work crop'
        for invalid_name, invalid_setup in [('missing', lambda: None), ('zero', lambda: Image.new('L',(16,16),0).save(mask)), ('corrupt', lambda: mask.write_bytes(b'not-an-image'))]:
            mask.unlink(missing_ok=True); invalid_setup()
            try: merge(str(base),str(manifest),str(output))
            except ValueError as error: assert '遮罩' in str(error), invalid_name
            else: raise AssertionError(f'{invalid_name} person mask must fail closed')
    # A successful PairDETR pass is not committed unless SAM also succeeds.
    fake_rtm=[{'box':[1,1,9,19],'score':.9,'mask':np.ones((20,20),np.uint8)}]
    advanced=type('Advanced',(),{'run_pairdetr':lambda *_:[{'box':[1,1,9,19],'score':.9},{'box':[11,1,19,19],'score':.8}], 'run_sam2':lambda *_:(_ for _ in ()).throw(RuntimeError('sam failed'))})()
    with tempfile.TemporaryDirectory() as temporary, \
         mock.patch.object(team_retouch,'load_rgb',return_value=np.zeros((20,20,3),np.uint8)), \
         mock.patch.object(team_retouch,'infer_rtmdet',return_value=fake_rtm), \
         mock.patch.object(team_retouch,'generate_work_tasks',return_value=([],[])):
        fake_session=type('Session',(),{'get_providers':lambda _self:['CPUExecutionProvider']})()
        result=team_retouch.detect('input.jpg',temporary,session_bundle=(fake_session,['CPUExecutionProvider'],'cpu'),advanced_runner=advanced,advanced_mode='auto')
        assert result['personCount']==1 and result['detector']=='rtmdet-ins-m' and not result['advancedBackend']
    # The current identity contract uses path/manualIdentityId; sourcePath is rejected.
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary); image=root/'photo.png'; Image.new('RGB',(24,24),'gray').save(image)
        invalid=root/'invalid.json'; invalid.write_text(json.dumps({'subjects':[{'key':'x','photoId':'p','sourcePath':str(image),'bbox':{'x':0,'y':0,'width':20,'height':20}}]}),encoding='utf-8')
        try: identify_people(str(invalid),runtime=object())
        except KeyError as error: assert error.args==('path',)
        else: raise AssertionError('non-contract sourcePath identity input must be rejected')
        class FakeRuntime:
            face_backend='fake-face'; body_backend='fake-body'; provider='CPU'
            def describe(self,rgb,item):
                assert item['path']==str(image) and item['manualIdentityId']=='known'
                return {'key':item['key'],'photoId':item['photoId'],'manualIdentityId':item['manualIdentityId'],'face':None,'faceQuality':0,'bodyInput':np.zeros((3,256,128),np.float32),'bodyQuality':0}
            def embed_bodies(self,descriptors):
                assert len(descriptors)==1, 'body tensors are embedded and released per image, not retained for the full project'
                for descriptor in descriptors: descriptor.pop('bodyInput'); descriptor['body']=np.ones(4,np.float32)/2; descriptor['bodyBackend']='fake-body'
        valid=root/'valid.json'; valid.write_text(json.dumps({'subjects':[{'key':'x','photoId':'p','path':str(image),'manualIdentityId':'known','bbox':{'x':0,'y':0,'width':20,'height':20}}]}),encoding='utf-8')
        assert identify_people(str(valid),runtime=FakeRuntime())['subjectCount']==1
    compact=identity_engine.CompactPairMetrics(2000)
    assert compact.values.nbytes+compact.flags.nbytes < 40*1024*1024, '2000-subject pair cache must stay compact and bounded'
    # Supplied face boxes on constant pixels must not become high-quality evidence.
    runtime=identity_engine.IdentityRuntime.__new__(identity_engine.IdentityRuntime)
    runtime._detect_faces=lambda *_: []
    runtime._face_feature=lambda _aligned:(np.ones(4,np.float32)/2,1.0)
    runtime.face_backend='fake'; runtime.body_backend='fake'
    _feature,quality,_box=runtime._face_descriptor(np.full((100,60,3),127,np.uint8),{'bbox':{'x':0,'y':0,'width':60,'height':100},'faceBox':{'x':10,'y':8,'width':40,'height':40}})
    assert quality<.2, 'constant supplied face crops must not provide high-confidence evidence'
    # Dimension normalization is required, but a textureless white background
    # must not trigger a second geometric resample around a dark silhouette.
    base=np.full((80,80,3),245,np.uint8); base[:,26:54]=20
    small=base[::2,::2].copy(); person_support=np.zeros((80,80),np.float32); person_support[:,20:60]=1
    with mock.patch('patch_merge.cv2.findTransformECC', side_effect=AssertionError('ECC should be skipped')):
        normalized,alignment=align_patch(base,small,person_support)
    assert normalized.shape==base.shape and alignment['resized'] and not alignment['applied']
    assert alignment['reason']=='low-texture-background'
    # A low-confidence translation proposal is diagnostic only; its pixels may
    # not replace the already resized return.
    yy,xx=np.indices((96,96)); texture=(((xx//4+yy//4)%2)*190+25).astype(np.uint8)
    textured=np.repeat(texture[...,None],3,axis=2)
    shifted=np.roll(textured,2,axis=1); empty_support=np.zeros((96,96),np.float32)
    proposed=np.asarray([[1,0,2],[0,1,0]],np.float32)
    with mock.patch('patch_merge.cv2.findTransformECC', return_value=(0.40,proposed)):
        rejected,rejected_alignment=align_patch(textured,shifted,empty_support)
    assert np.array_equal(rejected,shifted) and not rejected_alignment['applied']
    assert rejected_alignment['reason']=='insufficient-improvement'
    # A strong, bounded background translation is allowed, but it is rounded
    # to whole pixels so alignment cannot create new gray edge values.
    with mock.patch('patch_merge.cv2.findTransformECC', return_value=(0.99,proposed)):
        accepted,accepted_alignment=align_patch(textured,shifted,empty_support)
    assert accepted_alignment['applied'] and accepted_alignment['dx']==2
    assert set(np.unique(accepted)).issubset(set(np.unique(shifted))), 'integer alignment must not synthesize interpolated colors'
    # Conflicting overlap must select a single source instead of averaging two
    # displaced silhouettes into a visible double edge. Equal confidence uses
    # the later (relay-complete) return.
    base=np.full((24,24,3),127,np.uint8)
    previous_delta=np.zeros_like(base,dtype=np.float32); previous_delta[:,:11]=-90
    current_delta=np.zeros_like(base,dtype=np.float32); current_delta[:,:13]=-90
    confidence=np.ones((24,24),np.float16)
    previous=np.clip(base.astype(np.float32)+previous_delta,0,255).astype(np.uint8)
    fused,next_confidence,conflicts=fuse_patch_delta(base,previous,confidence,np.ones((24,24),np.float32),current_delta)
    expected=np.clip(base.astype(np.float32)+current_delta,0,255).astype(np.uint8)
    assert conflicts>0 and np.array_equal(fused,expected) and np.all(next_confidence==1), 'overlap fusion must not create an averaged ghost contour'
    # A moved high-contrast edge is an edit, so the old source edge must not be
    # re-injected as texture into the returned patch.
    source=np.full((64,64,3),220,np.uint8); source[:,:30]=30
    edited=np.full((64,64,3),220,np.uint8); edited[:,:34]=30
    weight,delta,_=edit_weight_and_delta(source,edited)
    enhanced=np.clip(source.astype(np.float32)+delta,0,255)
    changed=weight>0.5
    assert np.max(np.abs(enhanced[changed]-edited.astype(np.float32)[changed]))<1.0, 'changed silhouettes must not retain source-edge detail'
    # Mask dilation may provide edit headroom, but it must not carry a gray
    # background band along with the person. A genuinely moved dark silhouette
    # still has enough evidence to use that outer support.
    core=np.zeros((20,24),np.float32); core[:,:12]=1
    support=np.zeros((20,24),np.float32); support[:,:18]=1
    delta=np.zeros((20,24,3),np.float32); delta[:,12:15]=40; delta[:,15:18]=180
    protected=constrain_person_boundary(np.full((20,24),0.42,np.float32),delta,core,support)
    assert np.max(protected[:,12:15])<0.08, 'low-contrast background changes must not form a halo outside the person mask'
    assert np.min(protected[:,15:18])>0.99, 'high-confidence silhouette movement must retain outer edit support'
    # Exercise the final pixel equation on a feathered mask: a dark silhouette
    # extended over white must contain returned black or untouched white, never
    # the broad gray band produced by partial alpha.
    base=np.full((48,64,3),245,np.uint8); base[:,:26]=16
    edited=base.copy(); edited[:,26:34]=16
    core=np.zeros((48,64),np.float32); core[:,:26]=1
    support=np.zeros((48,64),np.float32); support[:,:26]=1
    support[:,26:34]=np.asarray([1,.85,.70,.55,.40,.25,.15,.10],np.float32)
    weight,delta,_=edit_weight_and_delta(base,edited)
    weight=constrain_person_boundary(weight,delta,core,support)
    fused,_,_=fuse_patch_delta(base,base,np.zeros((48,64),np.float16),weight,delta)
    moved=fused[12:-12,26:34,0]
    assert np.max(moved)<=20 and not np.any((moved>32)&(moved<230)), 'high-contrast contour replacement must not synthesize a gray ghost band'
    assert np.all(fused[12:-12,34:40,0]==245), 'background outside person support must stay byte-identical'
    print('team-retouch independent algorithm tests passed')
if __name__=='__main__': main()
