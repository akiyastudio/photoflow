"""Strict parser for the two trusted advanced checkpoint digests."""
from __future__ import annotations

import hashlib
from pathlib import Path

EXPECTED_CHECKPOINTS = {
    "checkpoints/pairdetr/pytorch_model.bin": "pytorch_model.bin",
    "checkpoints/sam2/sam2.1_hiera_large.pt": "sam2.1_hiera_large.pt",
}


def read_checkpoint_lock(lock_path):
    values = {}
    for line in Path(lock_path).read_text(encoding="utf-8").splitlines():
        parts = line.strip().split()
        if len(parts) != 2 or len(parts[0]) != 64 or any(character not in "0123456789abcdef" for character in parts[0].lower()):
            raise RuntimeError("Checkpoint lock contains a malformed line")
        relative = parts[1].lstrip("*").replace("\\", "/")
        if relative not in EXPECTED_CHECKPOINTS or relative in values:
            raise RuntimeError(f"Checkpoint lock contains an unknown or duplicate path: {relative}")
        values[relative] = parts[0].lower()
    if set(values) != set(EXPECTED_CHECKPOINTS):
        raise RuntimeError("Checkpoint lock does not contain the exact required set")
    return values


def verify_checkpoint(checkpoint_path, relative_path, lock_path=None):
    if relative_path not in EXPECTED_CHECKPOINTS or Path(checkpoint_path).name != EXPECTED_CHECKPOINTS[relative_path]:
        raise RuntimeError(f"Checkpoint path is not canonical: {relative_path}")
    lock_path = Path(lock_path or Path.home() / "model-lab/release-locks/checkpoints.sha256")
    expected = read_checkpoint_lock(lock_path)[relative_path]
    digest = hashlib.sha256()
    with Path(checkpoint_path).open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError(f"Checkpoint SHA-256 mismatch: {relative_path}")
