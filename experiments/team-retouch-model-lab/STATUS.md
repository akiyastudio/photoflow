# Setup status

Last updated: 2026-07-23

## Completed

- Hardware preflight: RTX 5060 Ti 16 GB, NVIDIA driver 591.86.
- Clash-backed WSL networking configured with mirrored networking, automatic
  proxy discovery, DNS tunnelling, and the Windows proxy at `127.0.0.1:7897`.
- Isolated Ubuntu 24.04 WSL2 distribution `PhotoflowNative` registered under
  `.model-lab/wsl/PhotoflowNative`; WSL CUDA reports the RTX 5060 Ti.
- Miniforge installed under `/home/photoflowlab/miniforge3` with separate
  `openmmlab-export`, `pairdetr`, and `sam3` environments.
- Windows `plan1-cuda` environment installed with PyTorch 2.10 CUDA 13 and
  ONNX Runtime GPU 1.27.0.
- Scheme 1 model assets are present: YuNet, RTMPose-m Halpe26, and
  RTMDet-Ins-m. The latter was exported to a checked ONNX model and copied to
  `.model-lab/models/plan1/rtmdet-ins/rtmdet-ins_m_640x640.onnx`.
- Scheme 1 real-image CUDA smoke test passed for YuNet, RTMDet-Ins masks, and
  a batched RTMPose inference. All outputs were finite.
- PairDETR repository is pinned at
  `fbcdebdff44bb5e9e6a9d92240ff01f8eec30ebc`; its official Hugging Face
  checkpoint is downloaded and checksummed.
- PairDETR real-image CUDA smoke test passed with an exact state-dict match,
  finite outputs, and approximately 624 MiB peak allocated GPU memory at a
  `480 x 649` model input.
- SAM 2.1 repository is pinned at
  `2b90b9f5ceec907a1c18123530e92e794ad901a4`; the public Hiera Large checkpoint
  is downloaded from Meta and checksummed.
- The complete Scheme 2 bridge passed a real-image CUDA smoke test: PairDETR
  emitted 8 de-duplicated body prompts and SAM 2.1 produced 8 non-empty masks at
  the original `768 x 1039` resolution. Peak allocated GPU memory was about
  1.64 GiB.
- SAM 3 repository is pinned at
  `46957e47805eaa273f4aa7bbbd25a88bca9108ce`; its isolated CUDA environment,
  import test, and dependency checks pass. Missing upstream runtime declarations
  (`einops`, `pycocotools`, and `psutil`) are pinned by the setup script.
- Conda explicit locks, pip freezes, repository commits, and checkpoint hashes
  are recorded under `/home/photoflowlab/model-lab/env-locks`.

## Optional future upgrade

The gated `facebook/sam3` checkpoint cannot be downloaded until the user
accepts its Hugging Face terms and performs an interactive `hf auth login` in
the isolated `sam3` environment. The current authentication state is
`Not logged in`. This no longer blocks Scheme 2 because SAM 2.1 is active.

## Next checks

1. Run both routes on original group photos, not screenshots containing UI,
   duplicate previews, or detection overlays.
2. Compare both routes on the same 20-image set before production integration.
3. Optionally download and evaluate SAM 3 after its access request is approved.
