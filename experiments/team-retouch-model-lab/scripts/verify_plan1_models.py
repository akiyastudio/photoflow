from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import torch

_torch_lib = Path(torch.__file__).resolve().parent / "lib"
_torch_dll_directory = os.add_dll_directory(str(_torch_lib))
import onnxruntime as ort

ort.preload_dlls(directory=str(_torch_lib))


def describe_model(path: Path) -> dict[str, object]:
    session = ort.InferenceSession(
        str(path), providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
    )
    active_providers = session.get_providers()
    if "CUDAExecutionProvider" not in active_providers:
        raise RuntimeError(
            f"CUDAExecutionProvider was not activated for {path}; "
            f"active providers: {active_providers}"
        )
    return {
        "path": str(path),
        "providers": active_providers,
        "inputs": [
            {"name": item.name, "shape": item.shape, "type": item.type}
            for item in session.get_inputs()
        ],
        "outputs": [
            {"name": item.name, "shape": item.shape, "type": item.type}
            for item in session.get_outputs()
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    args = parser.parse_args()

    model_root = args.workspace / ".model-lab" / "models" / "plan1"
    paths = [
        model_root / "yunet" / "face_detection_yunet_2023mar.onnx",
        model_root
        / "rtmpose"
        / "rtmpose-m_simcc-body7_pt-body7-halpe26_700e-256x192-4d3e73dd_20230605.onnx",
        model_root / "rtmdet-ins" / "rtmdet-ins_m_640x640.onnx",
    ]
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Missing model files: {missing}")

    report = {"models": [describe_model(path) for path in paths]}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
