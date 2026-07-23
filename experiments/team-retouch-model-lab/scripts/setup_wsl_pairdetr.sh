#!/usr/bin/env bash
set -euo pipefail

CONDA="$HOME/miniforge3/bin/conda"
ENV_NAME="pairdetr"
LAB_ROOT="$HOME/model-lab"
REPO_ROOT="$LAB_ROOT/repos"
LOCK_ROOT="$LAB_ROOT/env-locks"
VERIFY_SCRIPT="/mnt/c/dev/app2/experiments/team-retouch-model-lab/scripts/verify_modern_cuda.py"
PAIRDETR_COMMIT="fbcdebdff44bb5e9e6a9d92240ff01f8eec30ebc"

checkout_commit() {
    local url="$1"
    local commit="$2"
    local destination="$3"

    if [ ! -d "$destination/.git" ]; then
        mkdir -p "$destination"
        git -C "$destination" init
        git -C "$destination" remote add origin "$url"
    fi
    if [ -n "$(git -C "$destination" status --porcelain)" ]; then
        echo "Refusing to replace local changes in $destination" >&2
        exit 4
    fi
    git -C "$destination" fetch --depth 1 origin "$commit"
    git -C "$destination" checkout --detach "$commit"
    test "$(git -C "$destination" rev-parse HEAD)" = "$commit"
}

test -x "$CONDA"
mkdir -p "$REPO_ROOT" "$LOCK_ROOT"

if ! "$CONDA" run -n "$ENV_NAME" python -c 'import sys' >/dev/null 2>&1; then
    "$CONDA" create --yes --name "$ENV_NAME" python=3.10 pip
fi

run_env() {
    "$CONDA" run -n "$ENV_NAME" "$@"
}

run_env python -m pip install --upgrade \
    pip \
    wheel \
    setuptools==69.5.1
run_env python -m pip install \
    torch==2.10.0 \
    torchvision==0.25.0 \
    torchaudio==2.10.0 \
    --index-url https://download.pytorch.org/whl/cu128
run_env python -m pip install \
    numpy==1.26.4 \
    opencv-python-headless==4.10.0.84 \
    albumentations==1.2.0 \
    transformers==4.27.3 \
    pandas==1.5.3 \
    ortools==9.6.2534 \
    pytorch-lightning==1.9.3 \
    timm==0.6.13 \
    torchmetrics==0.11.4 \
    huggingface_hub==0.36.0 \
    safetensors

checkout_commit \
    https://github.com/mts-ai/pairdetr.git \
    "$PAIRDETR_COMMIT" \
    "$REPO_ROOT/pairdetr"

run_env python "$VERIFY_SCRIPT"
run_env python -m pip check
"$CONDA" list -n "$ENV_NAME" --explicit > "$LOCK_ROOT/${ENV_NAME}-conda-explicit.txt"
run_env python -m pip freeze > "$LOCK_ROOT/${ENV_NAME}-pip-freeze.txt"
git -C "$REPO_ROOT/pairdetr" rev-parse HEAD > "$LOCK_ROOT/pairdetr-head.txt"

echo "PairDETR environment is ready. The repository's original requirements.txt was intentionally not installed."

