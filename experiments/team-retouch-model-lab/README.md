# Team Retouch Model Lab

This directory is an isolated validation workspace for the multi-person retouch
pipeline. It does not import or modify the production UI, database, upload, or
merge workflow.

## Routes

- `S0`: current production detector, retained as the baseline.
- `S1`: YuNet face anchors + RTMDet-Ins-m + RTMPose-m (Halpe26), with a
  promptable segmenter or human review only for conflicts.
- `S2`: PairDETR face/body association + SAM 2.1 person masks, with the same
  crop and validation rules used by S1. SAM 3 remains a gated future upgrade.

## Local state

Large and machine-specific files live under the ignored repository directory:

```text
.model-lab/
  envs/                 # isolated Python environments
  models/               # model checkpoints and exported ONNX files
  cache/                # download and framework caches
  inputs/               # manifests or links to read-only source images
  outputs/              # JSON, masks, crops, overlays, and reports
```

Do not place credentials or Hugging Face tokens in this repository. Authenticate
interactively with `hf auth login` inside the SAM 3 environment.

## Environment layout

- Windows `plan1-cuda`: PyTorch 2.10 CUDA 13 and ONNX Runtime GPU for final ONNX
  validation and benchmark execution.
- WSL `openmmlab-export`: Python 3.10 and the legacy OpenMMLab stack, used only
  for CPU export of RTMDet-Ins to ONNX.
- WSL `pairdetr`: Python 3.10 and PyTorch 2.10 CUDA 12.8 for PairDETR inference.
- WSL `sam2`: Python 3.12 and PyTorch 2.10 CUDA 12.8 for the current public
  promptable-segmentation route.
- WSL `sam3`: Python 3.12 and PyTorch 2.10 CUDA 12.8 for SAM 3 inference.

The WSL environments and repositories live on the Linux ext4 filesystem under
`~/model-lab`. Final ONNX files, manifests, and benchmark reports are copied to
the ignored Windows `.model-lab` directory. Do not install an NVIDIA Linux driver
inside WSL; the Windows driver supplies the WSL CUDA bridge.

WSL uses mirrored networking and automatic proxy discovery so downloads follow
the Clash instance running on Windows. The reproducible settings are recorded in
`wslconfig.clash.example`; the machine-specific active copy is `%USERPROFILE%\.wslconfig`.

## Setup sequence

After WSL can start:

1. Run `bootstrap_wsl_lab.ps1` from PowerShell against `PhotoflowNative`.
2. Run `setup_wsl_openmmlab.sh` as the `photoflowlab` WSL user, then run
   `export_rtmdet_ins.sh`.
3. Run `setup_wsl_pairdetr.sh` and download the PairDETR checkpoint.
4. Run `setup_wsl_sam2.sh` and download the public SAM 2.1 Hiera Large
   checkpoint. SAM 3 setup is optional and its checkpoint remains gated.

PairDETR and SAM 3 are pinned to recorded repository commits. PairDETR's original
requirements file is not installed because it pins an old CUDA stack that cannot
execute on the RTX 5060 Ti. The first SAM 3 pass intentionally excludes optional
FlashAttention and compilation so that correctness is measured before speed.

## Smoke tests

- `scripts/smoke_plan1.py` runs YuNet, RTMDet-Ins, and RTMPose on the same real
  image through Windows ONNX Runtime CUDA.
- `scripts/smoke_pairdetr.py` constructs PairDETR, checks that every checkpoint
  key matches, runs one real CUDA inference, and can emit whole-body prompt
  boxes for the segmenter.
- `scripts/smoke_sam2.py` consumes those PairDETR body boxes and validates that
  SAM 2.1 produces one non-empty full-resolution mask per prompt.

Use original photos for accuracy comparisons. A screenshot containing duplicate
previews, UI text, and detection overlays is only suitable for execution tests.

## Experiment contract

Each route must emit one JSON result per source image using
`contracts/result.schema.json`. All coordinates are in the original image
coordinate system. Masks represent only visible pixels; they do not invent
occluded body pixels.

The first smoke set contains the supplied seven-person regression image. After
that succeeds, expand to 20 representative images before any production
integration.
