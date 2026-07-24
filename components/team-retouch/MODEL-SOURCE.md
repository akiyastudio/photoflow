# Team-retouch model sources

## Stable detector and mask fallback

`models/rtmdet-ins_m_640x640.onnx` is the MMDeploy export of
`rtmdet-ins_m_8xb32-300e_coco` from MMDetection.  PhotoFlow uses the COCO
`person` class at a 0.45 confidence threshold.  The exported model returns body
boxes and instance masks and runs through ONNX Runtime DirectML with CPU
fallback.

- Upstream: OpenMMLab MMDetection / MMDeploy
- Model family: RTMDet-Ins-m
- Input: 640 × 640 letterboxed BGR image
- Local SHA-256: run `Get-FileHash models/rtmdet-ins_m_640x640.onnx`

## Optional advanced backend

PairDETR and SAM 2.1 remain in their isolated WSL CUDA environments because
their PyTorch stacks and checkpoints are much larger than the Windows
component. The packaged component includes the inference bridge scripts and a
small offline-package importer in `advanced-installer/`; it never downloads
Linux, Python, repositories, or model files on an end-user computer. The large
WSL virtual disk is stored under
`%LOCALAPPDATA%/PhotoFlow/components/team-retouch/advanced/wsl/PhotoFlowNative`.

The deployment package contains `manifest.json` and a prepared
`PhotoFlowNative.vhdx`. Before importing it, PhotoFlow verifies the component
version, architecture, archive path safety, free space, and VHDX SHA-256.
`scripts/create-team-retouch-advanced-offline-package.ps1` exports a verified
environment into this package. The earlier `%LOCALAPPDATA%/PhotoFlow/wsl`
location remains detectable so existing installations can be migrated safely.

The bridge automatically activates the advanced backend when the following environments/checkpoints are
available in either the `PhotoFlowNative` or legacy `PhotoflowLab`
distribution. PhotoFlow tries both names automatically; a custom installation
can select another distribution with `PHOTOFLOW_WSL_DISTRO`:

- `$HOME/miniforge3/envs/pairdetr`
- `$HOME/miniforge3/envs/sam2`
- `$HOME/model-lab/checkpoints/pairdetr/pytorch_model.bin`
- `$HOME/model-lab/checkpoints/sam2/sam2.1_hiera_large.pt`

If the advanced backend is unavailable or fails, detection remains usable with
RTMDet and the reason is returned to the application for display.
