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

## Cross-photo identity models

Identity suggestions run locally and use three fixed model assets:

- `face_detection_yunet_2023mar.onnx` from OpenCV Zoo's YuNet face detector.
  The model directory is MIT licensed. Local SHA-256:
  `8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4`.
- `adaface_ir18_webface4m.onnx`, exported from the MIT-licensed AdaFace IR-18
  WebFace4M checkpoint. Local SHA-256:
  `F67C21148795C4B10F3063DEE16A0E9BFBB008BD94FCF0C0DAD7B16C2CFA1A54`.
- `osnet_x1_0_msmt17.onnx`, exported from Kaiyang Zhou's MIT-licensed Torchreid
  `osnet_x1_0_msmt17_combineall` checkpoint. Local SHA-256:
  `725DFAF07872CB5348E041F0B7C4CB5EF77259BAF385833A4CB1AB4BD04AF287`.

YuNet supplies five facial landmarks, AdaFace supplies aligned face embeddings,
and OSNet x1.0 supplies 512-dimensional full-body appearance embeddings. OSNet
is a supporting signal only; body-only matches remain review candidates. All
three assets are bundled into the team-retouch component ZIP and run on CPU,
with DirectML used only as an optional accelerator. There is no smaller-model
fallback or separate identity model package.

- AdaFace upstream: `mk-minchul/AdaFace`; the packaged IR-18 ONNX export is
  published by `yakhyo/adaface-onnx`. The reproducible conversion helper is
  `scripts/export-adaface.py`.
- OSNet x1.0 upstream: the official `kaiyangzhou/osnet` Hugging Face repository.
  It uses `scripts/export-osnet.py`.

Release builds read all prepared assets from this directory's `models/` folder
and include them through `npm run package`. The engine also accepts explicit local paths through
`PHOTOFLOW_ADAFACE_MODEL` and `PHOTOFLOW_OSNET_MODEL`. This allows development
and accuracy testing before the component ZIP is built.

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
`scripts/create-advanced-offline-package.ps1` exports a verified
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
