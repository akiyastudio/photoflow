"""Plugin-owned legacy storage snapshot/adoption regression."""
import sqlite3, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(ROOT/'compatibility'/'python'))
from team_retouch_v1.storage import ensure_schema, restore_project, snapshot

def main():
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary); source=root/'legacy.sqlite3'; portable=root/'snapshot.sqlite3'; destination=root/'restored.sqlite3'
        db=ensure_schema(str(source)); db.execute("INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)",('i','p','Person','#fff',1,1)); db.commit(); db.close()
        assert snapshot(str(source),str(portable))['success']
        ensure_schema(str(destination)).close(); result=restore_project(str(portable),str(destination),'p',[]); assert result['success']
        restored=sqlite3.connect(destination); assert restored.execute('SELECT name FROM team_person_identities WHERE id=?',('i',)).fetchone()[0]=='Person'; restored.close()
    print('team-retouch legacy storage isolation tests passed')
if __name__=='__main__': main()
