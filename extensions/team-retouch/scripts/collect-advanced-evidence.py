"""Collect notices and version evidence from a verified, isolated Linux profile."""
import argparse
import hashlib
import importlib.metadata
import json
import re
import shutil
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', required=True)
args = parser.parse_args()
output = Path(args.output_dir)
output.mkdir(parents=True, exist_ok=True)
environment = Path(sys.prefix).resolve()
records = []
for dist in sorted(importlib.metadata.distributions(), key=lambda d: d.metadata['Name'].lower()):
    name = dist.metadata['Name'].lower().replace('_', '-')
    notices = []
    for relative in dist.files or []:
        if not re.match(r'^(license|copying|notice|copyright|thirdpartynotices)(?:[._-]|$)', relative.name, re.I):
            continue
        source = Path(dist.locate_file(relative)).resolve()
        if not source.is_relative_to(environment) or not source.is_file():
            continue
        target = output / 'notices' / name / Path(*relative.parts)
        if not target.resolve().is_relative_to(output.resolve()):
            raise RuntimeError('Unsafe notice target path')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        notices.append({'path': target.relative_to(output).as_posix(), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    records.append({'name': name, 'version': dist.version, 'license': dist.metadata.get('License-Expression') or dist.metadata.get('License') or 'See upstream terms', 'sourceUrls': dist.metadata.get_all('Project-URL', []), 'notices': notices})
(output / 'python-distributions.json').write_text(json.dumps({'python': sys.version.split()[0], 'distributions': records}, indent=2) + '\n', encoding='utf-8')
print(f'Collected {len(records)} distributions; {sum(len(item["notices"]) for item in records)} notice files')
