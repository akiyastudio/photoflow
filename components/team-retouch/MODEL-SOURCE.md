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
- `face_recognition_sface_2021dec.onnx` from OpenCV Zoo's SFace recognizer.
  Consult the license shipped in that upstream model directory. Local SHA-256:
  `0BA9FBFA01B5270C96627C4EF784DA859931E02F04419C829E83484087C34E79`.
- `osnet_x0_25_msmt17.onnx`, exported from Kaiyang Zhou's MIT-licensed
  Torchreid `osnet_x0_25_msmt17_combineall` checkpoint hosted in the official
  `kaiyangzhou/osnet` Hugging Face repository. The reproducible conversion
  helper is `scripts/export-team-retouch-osnet.py`. Local SHA-256:
  `9213AE24C79D7CA1620E7FDEF0BCB03DC6FD8921EBAB336D61DC0BC2BED92E76`.

YuNet supplies five facial landmarks, SFace supplies aligned face embeddings,
and OSNet supplies 512-dimensional full-body appearance embeddings. OSNet is a
supporting signal only; body-only matches remain review candidates.

## Optional identity model pack

The identity engine can use an AdaFace IR-18 face model and an OSNet x1.0 body
model. They remain outside the base application and component, but release
builds publish them as a prepared optional model pack. End users do not need
Python, PyTorch, the upstream repositories, or a local ONNX conversion step.
The stable packaged fallback remains SFace plus OSNet x0.25.

- AdaFace upstream: `mk-minchul/AdaFace`. The reproducible conversion helper is
  `scripts/export-team-retouch-adaface.py`.
- OSNet x1.0 upstream: the official `kaiyangzhou/osnet` Hugging Face repository.
  It uses the same `scripts/export-team-retouch-osnet.py` conversion helper.

The prepared ZIP is built with `npm run build:model-packs`. It is placed,
without extraction, in `%LOCALAPPDATA%/PhotoFlow/components/team-retouch` and
installed from Settings. The ZIP includes a manifest, SHA-256 values, upstream
links, and license texts.

The engine also accepts explicit local paths through
`PHOTOFLOW_ADAFACE_MODEL` and `PHOTOFLOW_OSNET_MODEL`. This allows development
and accuracy testing without changing what is redistributed to end users.

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
