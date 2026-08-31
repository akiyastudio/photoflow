"""Independent algorithm regression tests for the plugin runtime."""
import io, json, subprocess, tempfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock
import numpy as np
from PIL import Image
import sys
ROOT=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(ROOT))
import advanced_bridge
from team_retouch import bounded_planning_box, emit_progress, maximize_assignment, plan_work_tiles, spatially_order_people
from patch_merge import constrain_person_boundary, edit_weight_and_delta, fuse_patch_delta, merge

def main():
    stream=io.StringIO()
    with redirect_stdout(stream): emit_progress(34,'working')
    assert json.loads(stream.getvalue())['progress']==34
    ordered=spatially_order_people([{'box':[100,0,120,20]},{'box':[0,0,20,20]}]); assert ordered[0]['box'][0]==0
    crop=bounded_planning_box([10,10,30,40],[10,10,30,40],100,100); assert crop[0]<=10 and crop[2]>=30
    tiles=plan_work_tiles([{'box':[5,5,35,45]},{'box':[40,5,70,45]}],100,100); assert tiles and sorted(set(sum((tile['indices'] for tile in tiles),[])))==[0,1]
    assert maximize_assignment([[0.9,0.1],[0.2,0.8]])==[0,1]
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
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary); base=root/'base.png'; patch=root/'patch.png'; mask=root/'mask.png'; output=root/'merged.tif'
        Image.new('RGB',(32,32),'black').save(base); Image.new('RGB',(16,16),'white').save(patch); Image.new('L',(16,16),255).save(mask)
        manifest=root/'merge.json'; manifest.write_text(json.dumps({'tasks':[{'id':'one','editedPatchPath':str(patch),'maskPath':str(mask),'crop':{'x':8,'y':8,'width':16,'height':16}}]}),encoding='utf-8')
        merge(str(base),str(manifest),str(output)); assert output.exists() and Image.open(output).size==(32,32)
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
    protected=constrain_person_boundary(np.ones((20,24),np.float32),delta,core,support)
    assert np.max(protected[:,12:15])<0.08, 'low-contrast background changes must not form a halo outside the person mask'
    assert np.min(protected[:,15:18])>0.99, 'high-confidence silhouette movement must retain outer edit support'
    print('team-retouch independent algorithm tests passed')
if __name__=='__main__': main()
