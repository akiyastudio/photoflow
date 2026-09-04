"""Export the official AdaFace IR-18 checkpoint used by this plugin."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import torch


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("photoflow_adaface_net", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load AdaFace model source: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path, help="Official AdaFace net.py")
    parser.add_argument("--weights", required=True, type=Path, help="Official AdaFace Lightning checkpoint")
    parser.add_argument("--architecture", default="ir_18")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    source_lock = Path(__file__).resolve().parents[1] / "models" / "source-checkpoints.json"
    if not source_lock.is_file():
        raise RuntimeError("Reviewed AdaFace source checkpoint lock is missing")
    expected_sha256 = str(json.loads(source_lock.read_text(encoding="utf-8")).get("adafaceWebFace4MSha256", "")).lower()
    if len(expected_sha256) != 64:
        raise RuntimeError("Reviewed AdaFace checkpoint SHA-256 is missing")
    digest = hashlib.sha256()
    with args.weights.resolve().open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected_sha256:
        raise RuntimeError("AdaFace checkpoint SHA-256 does not match the reviewed lock")

    net = load_module(args.source.resolve())
    model = net.build_model(args.architecture)
    checkpoint = torch.load(args.weights.resolve(), map_location="cpu", weights_only=True)
    state = checkpoint.get("state_dict", checkpoint)
    model.load_state_dict({key[6:]: value for key, value in state.items() if key.startswith("model.")}, strict=True)
    model.eval()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    example = torch.zeros(1, 3, 112, 112, dtype=torch.float32)
    torch.onnx.export(
        model,
        example,
        args.output.resolve(),
        input_names=["faces"],
        output_names=["embedding", "feature_norm"],
        dynamic_axes={"faces": {0: "batch"}, "embedding": {0: "batch"}, "feature_norm": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    print(args.output.resolve())


if __name__ == "__main__":
    main()
