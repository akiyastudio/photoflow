"""Independent algorithm regression tests for the plugin runtime."""
import io, json, tempfile
from contextlib import redirect_stdout
from pathlib import Path
import numpy as np
from PIL import Image
import sys
ROOT=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(ROOT))
from team_retouch import bounded_planning_box, emit_progress, maximize_assignment, plan_work_tiles, spatially_order_people
from patch_merge import merge

def main():
    stream=io.StringIO()
    with redirect_stdout(stream): emit_progress(34,'working')
    assert json.loads(stream.getvalue())['progress']==34
    ordered=spatially_order_people([{'box':[100,0,120,20]},{'box':[0,0,20,20]}]); assert ordered[0]['box'][0]==0
    crop=bounded_planning_box([10,10,30,40],[10,10,30,40],100,100); assert crop[0]<=10 and crop[2]>=30
    tiles=plan_work_tiles([{'box':[5,5,35,45]},{'box':[40,5,70,45]}],100,100); assert tiles and sorted(set(sum((tile['indices'] for tile in tiles),[])))==[0,1]
    assert maximize_assignment([[0.9,0.1],[0.2,0.8]])==[0,1]
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary); base=root/'base.png'; patch=root/'patch.png'; mask=root/'mask.png'; output=root/'merged.tif'
        Image.new('RGB',(32,32),'black').save(base); Image.new('RGB',(16,16),'white').save(patch); Image.new('L',(16,16),255).save(mask)
        manifest=root/'merge.json'; manifest.write_text(json.dumps({'tasks':[{'id':'one','editedPatchPath':str(patch),'maskPath':str(mask),'crop':{'x':8,'y':8,'width':16,'height':16}}]}),encoding='utf-8')
        merge(str(base),str(manifest),str(output)); assert output.exists() and Image.open(output).size==(32,32)
    print('team-retouch independent algorithm tests passed')
if __name__=='__main__': main()
