"""Export the official AdaFace IR-18 checkpoint used by team-retouch."""

from __future__ import annotations

import argparse
import importlib.util
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

    net = load_module(args.source.resolve())
    model = net.build_model(args.architecture)
    checkpoint = torch.load(args.weights.resolve(), map_location="cpu", weights_only=False)
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
