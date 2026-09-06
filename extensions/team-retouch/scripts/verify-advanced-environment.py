"""Verify a constructed advanced profile against reviewed artifact identities."""
import argparse
import hashlib
import importlib.metadata
import json
import sys
from pathlib import Path


def verify(profile, source_root):
    root = Path(source_root)
    metadata = json.loads((root/'advanced/source-metadata.json').read_text(encoding='utf-8'))
    expected = metadata['profiles'][profile]
    if f'{sys.version_info.major}.{sys.version_info.minor}' != expected['pythonVersion']:
        raise RuntimeError(f'{profile}: Python version does not match the release profile')
    normalize = lambda name: name.lower().replace('_', '-')
    actual = {normalize(d.metadata['Name']): d.version for d in importlib.metadata.distributions()}
    versions = {normalize(item['name']): item['version'] for item in expected['distributions']}
    for name, version in versions.items():
        if actual.get(name) != version:
            raise RuntimeError(f'{profile}: {name} expected {version}, found {actual.get(name)}')
    extras = set(actual) - set(versions) - {'pip'} - ({'sam-2'} if profile == 'sam2' else set())
    if extras:
        raise RuntimeError(f'{profile}: unexpected packages: {sorted(extras)}')
    for item in metadata['helpers']:
        if hashlib.sha256((root/item['path']).read_bytes()).hexdigest() != item['sha256']:
            raise RuntimeError('Advanced helper source checksum mismatch')
    print(json.dumps({'profile': profile, 'python': sys.version.split()[0], 'distributions': actual, 'status': 'passed'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', choices=['pairdetr', 'sam2'], required=True)
    parser.add_argument('--source-root', required=True)
    args = parser.parse_args()
    verify(args.profile, args.source_root)
