from __future__ import annotations

import json
import os
import platform
import sys
from pathlib import Path

import cv2
import numpy
import torch

_torch_lib = Path(torch.__file__).resolve().parent / "lib"
_torch_dll_directory = os.add_dll_directory(str(_torch_lib))
import onnxruntime as ort
from PIL import Image

ort.preload_dlls(directory=str(_torch_lib))


def main() -> int:
    providers = ort.get_available_providers()
    report = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "onnxruntime": ort.__version__,
        "providers": providers,
        "torch": torch.__version__,
        "torch_cuda": torch.version.cuda,
        "torch_cuda_available": torch.cuda.is_available(),
        "torch_cuda_dll_directory": str(_torch_lib),
        "numpy": numpy.__version__,
        "opencv": cv2.__version__,
        "pillow": Image.__version__,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not torch.cuda.is_available():
        print("ERROR: PyTorch cannot access CUDA.", file=sys.stderr)
        return 2
    if "CUDAExecutionProvider" not in providers:
        print(
            "ERROR: CUDAExecutionProvider is unavailable; refusing to silently use CPU.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
