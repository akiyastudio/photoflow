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
import identity_engine, team_retouch, image_safety
from advanced_geometry import normalized_cxcywh_to_original_xyxy
from checkpoint_lock import read_checkpoint_lock
from team_retouch import bounded_planning_box, emit_progress, identify_people, match_returned_batch, maximize_assignment, plan_work_tiles, restore_patches, spatially_order_people
from patch_merge import align_patch, constrain_person_boundary, edit_weight_and_delta, fuse_patch_delta, merge

def main():
    stream=io.StringIO()
    with redirect_stdout(stream): emit_progress(34,'working')
    assert json.loads(stream.getvalue())['progress']==34
    ordered=spatially_order_people([{'box':[100,0,120,20]},{'box':[0,0,20,20]}]); assert ordered[0]['box'][0]==0
    crop=bounded_planning_box([10,10,30,40],[10,10,30,40],100,100); assert crop[0]<=10 and crop[2]>=30
    tiles=plan_work_tiles([{'box':[5,5,35,45]},{'box':[40,5,70,45]}],100,100); assert tiles and sorted(set(sum((tile['indices'] for tile in tiles),[])))==[0,1]
    assert normalized_cxcywh_to_original_xyxy([.5,.5,.5,.5],6000,4000)==[1500,1000,4500,3000], 'PairDETR normalized boxes must map to the original non-square image'
    pair_box=normalized_cxcywh_to_original_xyxy([.25,.5,.2,.4],6000,4000)
    assert pair_box==[900,1200,2100,2800] and team_retouch.box_iou(pair_box,[900,1200,2100,2800])==1.0, 'PairDETR, RTMDet and SAM prompts must share original-image coordinates'
    huge_tiles=plan_work_tiles([{'box':[0,0,10000,16000]}],10000,16000,oversize_crop_mode='expand')
    assert huge_tiles[0]['crop'][2]*huge_tiles[0]['crop'][3]==160_000_000 and huge_tiles[0]['outputSize'][0]*huge_tiles[0]['outputSize'][1]<=40_000_000
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
        patterns={
            'constant':np.zeros((128,128),np.uint8),
            'two-color':np.pad(np.zeros((128,64),np.uint8),((0,0),(0,64)),constant_values=255),
            'gradient':np.tile(np.arange(128,dtype=np.uint8),(128,1)),
            'low-noise':np.random.default_rng(7).integers(124,130,(128,128),dtype=np.uint8),
            'normal':((np.indices((128,128))[1]*3+np.indices((128,128))[0]*2)%180+50).astype(np.uint8),
        }
        yy,xx=np.indices((128,128)); portrait=patterns['normal']; portrait[((xx-64)/30)**2+((yy-58)/42)**2<1]=150; portrait[((xx-53)**2+(yy-50)**2)<16]=25; portrait[((xx-75)**2+(yy-50)**2)<16]=25; portrait[76:82,50:78]=70; portrait[96:128,25:103]=45
        quality={}
        for name,pixels in patterns.items():
            target=root/f'{name}.png'; Image.fromarray(pixels,'L').save(target)
            quality[name]=team_retouch.match_information_sufficient(team_retouch.describe_match_image(target))
        assert not any(quality[name] for name in ('constant','two-color','gradient','low-noise')), quality
        assert quality['normal'], quality
        portrait_return=portrait.copy(); portrait_return[42:48,60:66]=190
        Image.fromarray(portrait_return,'L').save(returned); Image.fromarray(portrait,'L').save(candidate)
        with redirect_stdout(io.StringIO()): portrait_match=match_returned_batch(str(manifest))['matches'][0]
        assert portrait_match['informationGate']=={'returned':True,'candidate':True}, portrait_match
        high_key=(247-((np.indices((256,192))[0]+np.indices((256,192))[1])%8)).astype(np.uint8)
        hy,hx=np.indices(high_key.shape); high_key[((hx-96)/25)**2+((hy-72)/32)**2<1]=190; high_key[104:256,55:137]=92
        high_key[((hx-87)**2+(hy-67)**2)<9]=35; high_key[((hx-105)**2+(hy-67)**2)<9]=35; high_key[86:90,86:107]=110
        high_path=root/'high-key.png'; Image.fromarray(high_key,'L').save(high_path)
        high_descriptor=team_retouch.describe_match_image(high_path)
        assert team_retouch.match_information_sufficient(high_descriptor), {key:high_descriptor[key] for key in ('grayStd','entropy','edgeFraction','edgeCellCount','keypointCount','keypointCoverage')}
        high_edit=high_key.copy(); high_edit[72:78,112:118]=205; Image.fromarray(high_key,'L').save(candidate); Image.fromarray(high_edit,'L').save(returned)
        with redirect_stdout(io.StringIO()): high_match=match_returned_batch(str(manifest))['matches'][0]
        assert high_match['informationGate']=={'returned':True,'candidate':True}, high_match
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
            self.stdin=io.BytesIO(); self.stdout=io.BytesIO(stdout if stdout is not None else b'{"type":"ready","protocolVersion":1}\n{"success":true,"protocolVersion":1,"requestId":"req","value":7}\n{"success":true,"protocolVersion":1,"requestId":"req","type":"stopped"}\n'); self.stderr=io.BytesIO(stderr if stderr is not None else b'diagnostic-tail')
            self.returncode=None
        def poll(self): return self.returncode
        def wait(self,timeout=None): self.returncode=0; return 0
        def terminate(self): self.returncode=0
        def kill(self): self.returncode=-9
    burst=b''.join(f'diagnostic-{index}\n'.encode() for index in range(400))+b'{"type":"ready","protocolVersion":1}\n{"success":true,"protocolVersion":1,"requestId":"stale","value":1}\n{"success":true,"protocolVersion":1,"requestId":"req","value":7}\n{"success":true,"protocolVersion":1,"requestId":"req","type":"stopped"}\n'
    fake_process=FakeProcess(burst, b'x'*20000)
    with mock.patch.object(advanced_bridge,'distro_candidates',return_value=('FakeDistro',)), \
         mock.patch.object(advanced_bridge,'wsl_path',return_value='/component/service.py'), \
         mock.patch.object(advanced_bridge.subprocess,'Popen',return_value=fake_process), \
         mock.patch.object(advanced_bridge.uuid,'uuid4',return_value=type('Id',(),{'hex':'req'})()):
        bridge=advanced_bridge._WslJsonService('/python',Path('service.py'))
        assert len(bridge.reader_threads)==2, 'one fixed reader per stdout/stderr is created for the process'
        assert bridge.request({'action':'test'},timeout=1)['value']==7
        readers=list(bridge.reader_threads)
        bridge.close()
        assert all(not worker.is_alive() for worker in readers), 'normal close joins both fixed reader threads'
    concurrent_process=FakeProcess(b'{"type":"ready","protocolVersion":1}\n{"success":true,"protocolVersion":1,"requestId":"a","value":1}\n{"success":true,"protocolVersion":1,"requestId":"b","value":2}\n')
    ids=[type('Id',(),{'hex':'a'})(),type('Id',(),{'hex':'b'})()]
    with mock.patch.object(advanced_bridge,'distro_candidates',return_value=('FakeDistro',)), \
         mock.patch.object(advanced_bridge,'wsl_path',return_value='/component/service.py'), \
         mock.patch.object(advanced_bridge.subprocess,'Popen',return_value=concurrent_process), \
         mock.patch.object(advanced_bridge.uuid,'uuid4',side_effect=ids):
        bridge=advanced_bridge._WslJsonService('/python',Path('service.py')); values=[]
        workers=[threading.Thread(target=lambda: values.append(bridge.request({'action':'test'},timeout=1)['value'])) for _ in range(2)]
        for worker in workers: worker.start()
        for worker in workers: worker.join()
        assert sorted(values)==[1,2], values
        bridge._close_process(force=True)
    closed=[]
    session=advanced_bridge.AdvancedBatchSession(); session.sam=type('Bad',(),{'close':lambda _self:(_ for _ in ()).throw(RuntimeError('sam close'))})(); session.pair=type('Good',(),{'close':lambda _self:closed.append('pair')})()
    try: session.__exit__(None,None,None)
    except RuntimeError: pass
    else: raise AssertionError('close failure must remain observable')
    assert closed==['pair'], 'both advanced services close best-effort even if one fails'
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
    timeout_process=FakeProcess(b'{"type":"ready","protocolVersion":1}\n', b'request-timeout')
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
            output.unlink(missing_ok=True)
            mask.unlink(missing_ok=True); invalid_setup()
            try: merge(str(base),str(manifest),str(output))
            except ValueError as error: assert '遮罩' in str(error), invalid_name
            else: raise AssertionError(f'{invalid_name} person mask must fail closed')
            assert not output.exists(), f'{invalid_name} mask failure must not leave output'
    # A successful PairDETR pass is not committed unless SAM also succeeds.
    fake_rtm=[{'box':[1,1,9,19],'score':.9,'mask':np.ones((20,20),np.uint8)}]
    calls=[]
    advanced=type('Advanced',(),{'run_pairdetr':lambda *_:(calls.append('pair') or [{'box_xyxy':[1,1,9,19],'pair_score':.9},{'box_xyxy':[11,1,19,19],'pair_score':.8}]), 'run_sam2':lambda *_:(calls.append('sam') or (_ for _ in ()).throw(RuntimeError('sam failed')))})()
    with tempfile.TemporaryDirectory() as temporary, \
         mock.patch.object(team_retouch,'load_rgb',return_value=np.zeros((20,20,3),np.uint8)), \
         mock.patch.object(team_retouch,'infer_rtmdet',return_value=fake_rtm), \
         mock.patch.object(team_retouch,'generate_work_tasks',return_value=([],[])):
        fake_session=type('Session',(),{'get_providers':lambda _self:['CPUExecutionProvider']})()
        result=team_retouch.detect('input.jpg',temporary,session_bundle=(fake_session,['CPUExecutionProvider'],'cpu'),advanced_runner=advanced,advanced_mode='auto')
        assert result['personCount']==1 and result['detector']=='rtmdet-ins-m' and not result['advancedBackend']
        assert calls==['pair','sam'], calls
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
        many_subjects=[{'key':str(index),'photoId':'many','path':str(image),'manualIdentityId':None,'bbox':{'x':0,'y':0,'width':20,'height':20}} for index in range(37)]
        valid.write_text(json.dumps({'subjects':many_subjects}),encoding='utf-8')
        batches=[]
        class BatchRuntime(FakeRuntime):
            def describe(self,rgb,item):
                return {'key':item['key'],'photoId':item['photoId'],'manualIdentityId':None,'face':None,'faceQuality':0,'bodyInput':np.zeros((3,256,128),np.float32),'bodyQuality':0}
            def embed_bodies(self,descriptors):
                batches.append(len(descriptors))
                for descriptor in descriptors: descriptor.pop('bodyInput'); descriptor['body']=np.ones(4,np.float32)/2; descriptor['bodyBackend']='fake-body'
        with mock.patch.object(team_retouch,'inspect_oriented_dimensions',wraps=team_retouch.inspect_oriented_dimensions) as inspected, mock.patch.object(team_retouch,'load_rgb',wraps=team_retouch.load_rgb) as decoded:
            identify_people(str(valid),runtime=BatchRuntime())
        assert inspected.call_count==1 and decoded.call_count==1, (inspected.call_count,decoded.call_count)
        assert batches==[12,12,12,1], batches
    compact=identity_engine.CompactPairMetrics(2000)
    assert compact.values.nbytes+compact.flags.nbytes < 40*1024*1024, '2000-subject pair cache must stay compact and bounded'
    compact.mark_skipped((0,1)); assert compact[(0,1)]['skipped'] and compact[(0,1)]['evidence']=='same-image'
    try: identity_engine.select_onnx_providers(['CPUExecutionProvider'],'gpu')
    except RuntimeError: pass
    else: raise AssertionError('explicit GPU must fail when DirectML is absent')
    assert identity_engine.select_onnx_providers(['DmlExecutionProvider','CPUExecutionProvider'],'cpu')==['CPUExecutionProvider']
    class FakeOrt:
        class ExecutionMode: ORT_SEQUENTIAL=1
        class SessionOptions: pass
        def __init__(self): self.calls=[]
        def get_available_providers(self): return ['DmlExecutionProvider','CPUExecutionProvider']
        def InferenceSession(self,path,sess_options,providers):
            self.calls.append((path,tuple(providers)))
            if providers[0]=='DmlExecutionProvider': raise RuntimeError('Dml init failed')
            return type('Session',(),{})()
    fake_ort=FakeOrt(); _body,_face,reason=identity_engine.create_identity_sessions(fake_ort,'body','face','auto')
    assert 'DirectML 初始化失败' in reason and fake_ort.calls==[('body',('DmlExecutionProvider','CPUExecutionProvider')),('body',('CPUExecutionProvider',)),('face',('CPUExecutionProvider',))]
    descriptors=[{'key':'a','photoId':'one','manualIdentityId':None},{'key':'b','photoId':'one','manualIdentityId':None},{'key':'c','photoId':'two','manualIdentityId':None}]
    metric_value={'score':.1,'faceScore':None,'bodyScore':.1,'faceQuality':0,'qualifies':False,'contradiction':False,'evidence':'body-only'}
    cross_cache=identity_engine.CompactPairMetrics(3)
    with mock.patch.object(identity_engine,'pair_metrics',return_value=metric_value) as computed:
        identity_engine.constrained_clusters(descriptors,cross_cache); first_count=computed.call_count
        identity_engine.ranked_similarity_pairs(descriptors,metrics_cache=cross_cache)
        assert first_count==2 and computed.call_count==2, computed.call_count
    with tempfile.TemporaryDirectory() as temporary:
        lock=Path(temporary)/'checkpoints.sha256'; lock.write_text(f"{'1'*64}  checkpoints/pairdetr/pytorch_model.bin\n{'2'*64}  checkpoints/sam2/sam2.1_hiera_large.pt\n",encoding='utf-8')
        assert len(read_checkpoint_lock(lock))==2
        lock.write_text(f"{'1'*64}  anywhere/pytorch_model.bin\n{'2'*64}  checkpoints/sam2/sam2.1_hiera_large.pt\n",encoding='utf-8')
        try: read_checkpoint_lock(lock)
        except RuntimeError: pass
        else: raise AssertionError('checkpoint suffix matching must not be accepted')
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary); image=root/'identity.png'; Image.new('RGB',(24,24),'gray').save(image); manifest=root/'identity.json'
        manifest.write_text(json.dumps({'subjects':[{'key':'x','photoId':'p','path':str(image),'bbox':{'x':0,'y':0,'width':20,'height':20}}]}),encoding='utf-8')
        class CpuRuntime:
            provider='CPUExecutionProvider'; face_backend='fake'; body_backend='fake'; fallback_reason=''
            def describe(self,rgb,item): return {'key':'x','photoId':'p','manualIdentityId':None,'face':None,'faceQuality':0,'bodyInput':np.zeros((3,256,128),np.float32),'bodyQuality':0}
            def embed_bodies(self,items):
                for item in items: item.pop('bodyInput'); item['body']=np.ones(4,np.float32)/2; item['bodyBackend']='fake'
        for failure in ('Dml AdaFace run failed','Dml body run failed'):
            gpu=type('GpuRuntime',(),{'provider':'DmlExecutionProvider','describe':lambda *_:(_ for _ in ()).throw(RuntimeError(failure))})()
            with mock.patch.object(team_retouch,'IdentityRuntime',side_effect=[gpu,CpuRuntime()]) as factory:
                fallback=identify_people(str(manifest),provider='auto')
            assert fallback['provider']=='CPUExecutionProvider' and '全量重跑 CPU' in fallback['fallbackReason'] and factory.call_count==2
        bad=type('BadDataRuntime',(),{'provider':'DmlExecutionProvider','describe':lambda *_:(_ for _ in ()).throw(ValueError('bad image'))})()
        with mock.patch.object(team_retouch,'IdentityRuntime',return_value=bad) as factory:
            try: identify_people(str(manifest),provider='auto')
            except ValueError: pass
            else: raise AssertionError('data errors must not fall back to CPU')
            assert factory.call_count==1
    with mock.patch.dict('os.environ',{'PHOTOFLOW_TEST_PHYSICAL_MEMORY_BYTES':str(8*1024**3)}):
        image_safety.validate_dimensions(100,100)
        for dimensions,role in [((0,10),'original'),((65536,1),'original'),((8000,6000),'work')]:
            try: image_safety.validate_dimensions(*dimensions,role=role)
            except ValueError: pass
            else: raise AssertionError(f'unsafe dimensions accepted: {dimensions} {role}')
    with mock.patch.dict('os.environ',{'PHOTOFLOW_TEST_PHYSICAL_MEMORY_BYTES':str(64*1024**3),'PHOTOFLOW_TEST_AVAILABLE_MEMORY_BYTES':str(1024**3)}):
        try: image_safety.validate_dimensions(10_000,10_000)
        except ValueError as error: assert '峰值内存' in str(error)
        else: raise AssertionError('large total memory must not hide low currently available memory')
    with tempfile.TemporaryDirectory() as temporary:
        oriented=Path(temporary)/'oriented.jpg'; exif=Image.Exif(); exif[274]=6; Image.new('RGB',(30,20),'gray').save(oriented,exif=exif)
        assert image_safety.inspect_oriented_dimensions(oriented)==(20,30)
        oriented_width,oriented_height=image_safety.inspect_oriented_dimensions(oriented)
        assert normalized_cxcywh_to_original_xyxy([.5,.5,.5,.5],oriented_width,oriented_height)==[5,7.5,15,22.5], 'EXIF-oriented PairDETR boxes must use displayed dimensions'
    with tempfile.TemporaryDirectory() as temporary, mock.patch.object(team_retouch,'MAX_WORK_PIXELS',100):
        root=Path(temporary); delivery=root/'delivery'; delivery.mkdir(); rgb=np.zeros((20,20,3),np.uint8)
        person={'box':[0,0,20,20],'planningBox':[0,0,20,20],'mask':np.ones((20,20),bool),'score':1,'source':'rtmdet','reviewReason':''}
        _people,tasks=team_retouch.generate_work_tasks(rgb,[person],root,delivery,'photo','test',oversize_crop_mode='expand')
        assert Image.open(tasks[0]['patchPath']).width*Image.open(tasks[0]['patchPath']).height<=100
        source=root/'source.png'; Image.fromarray(rgb,'RGB').save(source); restored_path=root/'restored.png'; restore_manifest=root/'restore.json'
        restore_manifest.write_text(json.dumps({'tasks':[{'id':'restore','patchPath':str(restored_path),'crop':{'x':0,'y':0,'width':20,'height':20}}]}),encoding='utf-8')
        restored=restore_patches(source,restore_manifest)
        assert restored['outputs'][0]['width']*restored['outputs'][0]['height']<=100 and Image.open(restored_path).size==(restored['outputs'][0]['width'],restored['outputs'][0]['height'])
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
