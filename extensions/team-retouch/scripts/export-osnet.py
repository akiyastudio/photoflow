"""Export official Torchreid OSNet weights to a runtime ONNX model.

This is a development helper. The shipped team-retouch component only needs
the generated ONNX file and does not depend on PyTorch or Torchreid.
"""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import torch


def load_osnet_module(source: Path):
    spec = importlib.util.spec_from_file_location("photoflow_torchreid_osnet", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 OSNet 源码：{source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path, help="Torchreid torchreid/models/osnet.py")
    parser.add_argument("--weights", required=True, type=Path, help="Official OSNet checkpoint")
    parser.add_argument("--architecture", default="osnet_x1_0", choices=("osnet_x0_25", "osnet_x0_5", "osnet_x0_75", "osnet_x1_0"))
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    osnet = load_osnet_module(args.source.resolve())
    model = getattr(osnet, args.architecture)(num_classes=4101, pretrained=False)
    state = torch.load(args.weights.resolve(), map_location="cpu", weights_only=True)
    model.load_state_dict(state, strict=True)
    model.eval()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    example = torch.zeros(1, 3, 256, 128, dtype=torch.float32)
    torch.onnx.export(
        model,
        example,
        args.output.resolve(),
        input_names=["images"],
        output_names=["embedding"],
        dynamic_axes={"images": {0: "batch"}, "embedding": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    print(args.output.resolve())


if __name__ == "__main__":
    main()
