#!/usr/bin/env bash
set -euo pipefail

CONDA="$HOME/miniforge3/bin/conda"
LAB_ROOT="$HOME/model-lab"
REPO_ROOT="$LAB_ROOT/repos"
CHECKPOINT_ROOT="$LAB_ROOT/checkpoints"
LOCK_ROOT="$LAB_ROOT/env-locks"
PAIRDETR_COMMIT="fbcdebdff44bb5e9e6a9d92240ff01f8eec30ebc"
SAM2_COMMIT="2b90b9f5ceec907a1c18123530e92e794ad901a4"

log() { printf '\n[PhotoFlow advanced setup] %s\n' "$1"; }

checkout_commit() {
    local url="$1" commit="$2" destination="$3"
    if [ ! -d "$destination/.git" ]; then
        mkdir -p "$destination"
        git -C "$destination" init
        git -C "$destination" remote add origin "$url"
    fi
    git -C "$destination" fetch --depth 1 origin "$commit"
    git -C "$destination" checkout --detach --force "$commit"
    test "$(git -C "$destination" rev-parse HEAD)" = "$commit"
}

test -x "$CONDA"
mkdir -p "$REPO_ROOT" "$CHECKPOINT_ROOT" "$LOCK_ROOT"

log "Creating PairDETR environment"
if ! "$CONDA" run -n pairdetr python -c 'import sys' >/dev/null 2>&1; then
    "$CONDA" create --yes --name pairdetr python=3.10 pip
fi
"$CONDA" run -n pairdetr python -m pip install --upgrade pip wheel setuptools==69.5.1
"$CONDA" run -n pairdetr python -m pip install \
    torch==2.10.0 torchvision==0.25.0 torchaudio==2.10.0 \
    --index-url https://download.pytorch.org/whl/cu128
"$CONDA" run -n pairdetr python -m pip install \
    numpy==1.26.4 opencv-python-headless==4.10.0.84 albumentations==1.2.0 \
    transformers==4.27.3 pandas==1.5.3 ortools==9.6.2534 \
    pytorch-lightning==1.9.3 timm==0.6.13 torchmetrics==0.11.4 \
    huggingface_hub==0.36.0 safetensors
checkout_commit https://github.com/mts-ai/pairdetr.git "$PAIRDETR_COMMIT" "$REPO_ROOT/pairdetr"
mkdir -p "$CHECKPOINT_ROOT/pairdetr"
"$CONDA" run -n pairdetr hf download MTSAIR/PairDETR --local-dir "$CHECKPOINT_ROOT/pairdetr"
test -s "$CHECKPOINT_ROOT/pairdetr/pytorch_model.bin"
PYTHONPATH="$CHECKPOINT_ROOT/pairdetr" "$CONDA" run -n pairdetr python -c \
    'import torch; from hf_utils import PairDetr, forward; assert torch.cuda.is_available(); print("PAIRDETR_CUDA_OK", torch.cuda.get_device_name(0))'

log "Creating SAM 2.1 environment"
if ! "$CONDA" run -n sam2 python -c 'import sys' >/dev/null 2>&1; then
    "$CONDA" create --yes --name sam2 python=3.12 pip
fi
"$CONDA" run -n sam2 python -m pip install --upgrade pip wheel setuptools==69.5.1 numpy==1.26.4
"$CONDA" run -n sam2 python -m pip install \
    torch==2.10.0 torchvision==0.25.0 \
    --index-url https://download.pytorch.org/whl/cu128
checkout_commit https://github.com/facebookresearch/sam2.git "$SAM2_COMMIT" "$REPO_ROOT/sam2"
"$CONDA" run -n sam2 env SAM2_BUILD_CUDA=0 python -m pip install \
    --no-build-isolation --editable "$REPO_ROOT/sam2"
"$CONDA" run -n sam2 python -m pip install setuptools==69.5.1 numpy==1.26.4
mkdir -p "$CHECKPOINT_ROOT/sam2"
curl --fail --location --retry 5 --continue-at - \
    --output "$CHECKPOINT_ROOT/sam2/sam2.1_hiera_large.pt" \
    https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt
test -s "$CHECKPOINT_ROOT/sam2/sam2.1_hiera_large.pt"
"$CONDA" run -n sam2 python -c \
    'import torch; from sam2.sam2_image_predictor import SAM2ImagePredictor; assert torch.cuda.is_available(); print("SAM2_CUDA_OK", torch.cuda.get_device_name(0))'

log "Recording reproducibility locks"
"$CONDA" list -n pairdetr --explicit > "$LOCK_ROOT/pairdetr-conda-explicit.txt"
"$CONDA" run -n pairdetr python -m pip freeze > "$LOCK_ROOT/pairdetr-pip-freeze.txt"
"$CONDA" list -n sam2 --explicit > "$LOCK_ROOT/sam2-conda-explicit.txt"
"$CONDA" run -n sam2 python -m pip freeze > "$LOCK_ROOT/sam2-pip-freeze.txt"
git -C "$REPO_ROOT/pairdetr" rev-parse HEAD > "$LOCK_ROOT/pairdetr-head.txt"
git -C "$REPO_ROOT/sam2" rev-parse HEAD > "$LOCK_ROOT/sam2-head.txt"
find "$CHECKPOINT_ROOT/pairdetr" "$CHECKPOINT_ROOT/sam2" -type f -print0 \
    | sort -z | xargs -0 sha256sum > "$LOCK_ROOT/checkpoint-sha256.txt"

log "PairDETR and SAM 2.1 are ready"
