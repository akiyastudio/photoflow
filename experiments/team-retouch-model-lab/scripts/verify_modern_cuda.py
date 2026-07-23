from __future__ import annotations

import json

import torch


def main() -> None:
    if not torch.cuda.is_available():
        raise RuntimeError("torch.cuda.is_available() is false")

    capability = torch.cuda.get_device_capability(0)
    arch_list = torch.cuda.get_arch_list()
    if capability != (12, 0):
        raise RuntimeError(f"Expected RTX 5060 Ti capability (12, 0), got {capability}")
    if "sm_120" not in arch_list:
        raise RuntimeError(f"This PyTorch build does not contain sm_120: {arch_list}")

    left = torch.randn((1024, 1024), device="cuda", dtype=torch.float16)
    right = torch.randn((1024, 1024), device="cuda", dtype=torch.float16)
    result = left @ right
    torch.cuda.synchronize()

    print(
        json.dumps(
            {
                "torch": torch.__version__,
                "cuda_runtime": torch.version.cuda,
                "device": torch.cuda.get_device_name(0),
                "capability": capability,
                "arch_list": arch_list,
                "smoke_shape": list(result.shape),
                "smoke_finite": bool(torch.isfinite(result).all().item()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
