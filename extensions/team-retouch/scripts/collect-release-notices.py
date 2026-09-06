"""Collect installed distribution notices and their exact build identities offline."""
import argparse
import hashlib
import importlib.metadata
import json
import re
import shutil
import sys
from pathlib import Path


def collect(output, development=False):
    root = Path(__file__).resolve().parents[1]
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    lock = (root / 'requirements-build.lock').read_text(encoding='utf-8')
    names = re.findall(r'^([A-Za-z0-9_.-]+)==([^\s]+)', lock, re.MULTILINE)
    records = []
    environment = Path(sys.prefix).resolve()
    for name, expected in names:
        dist = importlib.metadata.distribution(name)
        if not development and dist.version != expected:
            raise RuntimeError(f'Notice inventory version mismatch: {name}')
        files = []
        for relative in dist.files or []:
            if not re.match(r'^(license|copying|notice|copyright|thirdpartynotices)(?:[._-]|$)', relative.name, re.I):
                continue
            source = Path(dist.locate_file(relative)).resolve()
            if not source.is_relative_to(environment) or not source.is_file():
                raise RuntimeError(f'Notice escaped installed environment: {name}/{relative}')
            target = output / 'python' / name / Path(*relative.parts)
            # Installed records must not escape the component's notice directory.
            if not target.resolve().is_relative_to(output):
                raise RuntimeError('Unsafe installed notice path')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            files.append({'path': target.relative_to(output).as_posix(), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        if not files:
            fallback = output / 'upstream' / f'{name}.txt'
            if not fallback.is_file():
                raise RuntimeError(f'Missing full license text for {name}; acquire its upstream notice before packaging')
            files.append({'path': fallback.relative_to(output).as_posix(), 'sha256': hashlib.sha256(fallback.read_bytes()).hexdigest()})
        records.append({'name': name, 'version': dist.version, 'license': dist.metadata.get('License-Expression') or dist.metadata.get('License') or '', 'projectUrls': dist.metadata.get_all('Project-URL', []), 'notices': files})
    python_license = Path(sys.base_prefix) / 'LICENSE.txt'
    if not python_license.is_file():
        raise RuntimeError('Python runtime license missing')
    shutil.copyfile(python_license, output / 'Python-LICENSE.txt')
    (output / 'python-build-inventory.json').write_text(json.dumps({'pythonVersion': sys.version.split()[0], 'scope': 'locked Python build environment; package file inventory identifies delivered binaries', 'lockSha256': hashlib.sha256(lock.encode()).hexdigest(), 'distributions': records}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--development', action='store_true')
    args = parser.parse_args()
    collect(args.output_dir, args.development)
