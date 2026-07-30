from __future__ import annotations

import hashlib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = REPOSITORY_ROOT / "cloudbase" / "telemetry-function"
OUTPUT_PATH = REPOSITORY_ROOT / "output" / "photoflow-cloud-function-dashboard-cloudbase.zip"
FILES = (
    "index.js",
    "package.json",
    "package-lock.json",
    "scf_bootstrap",
    "admin/app.js",
    "admin/index.html",
    "admin/styles.css",
)


def add_file(archive: ZipFile, relative_path: str) -> None:
    source_path = SOURCE_ROOT / relative_path
    if not source_path.is_file():
        raise FileNotFoundError(source_path)

    executable = relative_path == "scf_bootstrap"
    unix_mode = 0o100755 if executable else 0o100644
    info = ZipInfo(relative_path, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.compress_type = ZIP_DEFLATED
    info.external_attr = unix_mode << 16
    archive.writestr(info, source_path.read_bytes())


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT_PATH, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for relative_path in FILES:
            add_file(archive, relative_path)

    with ZipFile(OUTPUT_PATH, "r") as archive:
        if archive.namelist() != list(FILES):
            raise RuntimeError("Unexpected ZIP file structure")
        corrupt_file = archive.testzip()
        if corrupt_file:
            raise RuntimeError(f"Corrupt ZIP entry: {corrupt_file}")
        bootstrap_mode = archive.getinfo("scf_bootstrap").external_attr >> 16
        if bootstrap_mode & 0o111 == 0:
            raise RuntimeError("scf_bootstrap is not executable")
        for relative_path in FILES:
            source_digest = hashlib.sha256((SOURCE_ROOT / relative_path).read_bytes()).digest()
            archive_digest = hashlib.sha256(archive.read(relative_path)).digest()
            if source_digest != archive_digest:
                raise RuntimeError(f"ZIP content mismatch: {relative_path}")

    archive_digest = hashlib.sha256(OUTPUT_PATH.read_bytes()).hexdigest().upper()
    print(OUTPUT_PATH)
    print(f"SHA256={archive_digest}")


if __name__ == "__main__":
    main()
