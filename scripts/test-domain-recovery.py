from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import domain_recovery  # noqa: E402


def create_media_store(path: Path, marker: str, original_path: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    try:
        db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        db.execute("INSERT INTO meta VALUES('schema_version','1')")
        db.execute("CREATE TABLE photos(id TEXT PRIMARY KEY,original_file_path TEXT,marker TEXT)")
        db.execute("INSERT INTO photos VALUES('photo',?,?)", (original_path, marker))
        db.commit()
    finally:
        db.close()


def main():
    with tempfile.TemporaryDirectory(prefix="photoflow-domain-recovery-") as temporary:
        root = Path(temporary)
        source = root / "source.sqlite3"
        destination = root / "destination.sqlite3"
        create_media_store(source, "snapshot", str(root / "old" / "photo.jpg"))
        create_media_store(destination, "current", str(root / "current" / "photo.jpg"))

        original_rebase = domain_recovery._rebase
        try:
            domain_recovery._rebase = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("injected rebase failure"))
            try:
                domain_recovery.restore_workspace(
                    str(source), str(destination), "media", [(str(root / "old"), str(root / "new"))]
                )
                raise AssertionError("injected restore failure must be reported")
            except RuntimeError as error:
                assert "injected rebase failure" in str(error)
        finally:
            domain_recovery._rebase = original_rebase
        current = sqlite3.connect(destination)
        try:
            assert current.execute("SELECT marker FROM photos").fetchone()[0] == "current"
        finally:
            current.close()

        restored = domain_recovery.restore_workspace(
            str(source), str(destination), "media", [(str(root / "old"), str(root / "new"))]
        )
        assert restored["success"] and Path(restored["backup"]).is_file()
        current = sqlite3.connect(destination)
        try:
            marker, original_path = current.execute(
                "SELECT marker,original_file_path FROM photos"
            ).fetchone()
            assert marker == "snapshot"
            assert Path(original_path) == root / "new" / "photo.jpg"
        finally:
            current.close()

        destination.write_bytes(b"corrupt-domain-store")
        reset = domain_recovery.reset_store(str(destination), "media")
        assert reset["success"] and reset["requiresReindex"]
        assert Path(reset["quarantine"]).read_bytes() == b"corrupt-domain-store"

    print("Atomic domain recovery tests passed.")


if __name__ == "__main__":
    main()
