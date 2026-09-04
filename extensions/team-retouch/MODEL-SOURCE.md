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
- Local SHA-256: `6041DDED9177D5BD0BCA9E3AA264CEB99EC1FF7B0D53320D2433587704840FCA`.

## Cross-photo identity models

Identity suggestions run locally and use three fixed model assets:

- `face_detection_yunet_2023mar.onnx` from OpenCV Zoo's YuNet face detector.
  OpenCV Zoo is Apache-2.0 licensed. Local SHA-256:
  `8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4`.
- `adaface_ir18_webface4m.onnx`, exported from the MIT-licensed AdaFace IR-18
  WebFace4M checkpoint. Local SHA-256:
  `6B6A35772FB636CDD4FA86520C1A259D0C41472A76F70F802B351837A00D9870`.
- `osnet_x1_0_msmt17.onnx`, exported from Kaiyang Zhou's MIT-licensed Torchreid
  `osnet_x1_0_msmt17_combineall` checkpoint. Local SHA-256:
  `7F545CFF27644DCC7481D53B2F6DF0B4BA22CEFF71F1A839C83A1BE5C0973EAE`.

YuNet supplies five facial landmarks, AdaFace supplies aligned face embeddings,
and OSNet x1.0 supplies 512-dimensional full-body appearance embeddings. OSNet
is a supporting signal only; body-only matches remain review candidates. All
three assets are bundled into the team-retouch component ZIP and run on CPU,
with DirectML used only as an optional accelerator. There is no smaller-model
fallback or separate identity model package.

- AdaFace source and checkpoint: `https://github.com/mk-minchul/AdaFace`
  (`net.py`) and its official R18 WebFace4M checkpoint linked from that
  repository (Google Drive file `1J17_QW1Oq00EhSWObISnhWEYr2NNrg2y`).
  Export with `scripts/export-adaface.py --source <AdaFace/net.py> --weights
  <AdaFaceWebFace4M.ckpt> --architecture ir_18 --output
  models/adaface_ir18_webface4m.onnx`.
- OSNet source and checkpoint: `https://github.com/KaiyangZhou/deep-person-reid`
  (`torchreid/models/osnet.py`) and the official Hugging Face file
  `osnet_x1_0_msmt17_combineall_256x128_amsgrad_ep150_stp60_lr0.0015_b64_fb10_softmax_labelsmooth_flip_jitter.pth`
  (upstream SHA-256
  `48DF972F72887B95CF3B43B3A07C3A7D2398381AEA0F9CAE64A7EF11D512B727`).
  Export with `scripts/export-osnet.py --source <deep-person-reid/torchreid/models/osnet.py>
  --weights <checkpoint.pth> --architecture osnet_x1_0 --output
  models/osnet_x1_0_msmt17.onnx`.

Create the export environment with
`python -m pip install -r requirements-model-export.txt`. PyTorch/ONNX export
bytes can vary across tool versions, so release preparation must compare every
result with the fixed SHA-256 values above; a mismatch is not silently accepted.
All ONNX files under `models/` are tracked by Git LFS through `.gitattributes`.
License and attribution details are recorded in `LICENSES.md`.

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
environment into this package. The networked environment builder lives under
`scripts/` and is never copied into the installable component.

The bridge activates the advanced backend only from the `PhotoFlowNative`
distribution (or the explicit development override `PHOTOFLOW_WSL_DISTRO`)
when these environments/checkpoints are available:

- `$HOME/miniforge3/envs/pairdetr`
- `$HOME/miniforge3/envs/sam2`
- `$HOME/model-lab/checkpoints/pairdetr/pytorch_model.bin`
- `$HOME/model-lab/checkpoints/sam2/sam2.1_hiera_large.pt`

If the advanced backend is unavailable or fails, detection remains usable with
RTMDet and the reason is returned to the application for display.
