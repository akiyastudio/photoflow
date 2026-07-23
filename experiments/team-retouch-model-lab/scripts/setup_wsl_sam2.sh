#!/usr/bin/env bash
set -euo pipefail

CONDA="$HOME/miniforge3/bin/conda"
ENV_NAME="sam2"
LAB_ROOT="$HOME/model-lab"
REPO_ROOT="$LAB_ROOT/repos"
LOCK_ROOT="$LAB_ROOT/env-locks"
VERIFY_SCRIPT="/mnt/c/dev/app2/experiments/team-retouch-model-lab/scripts/verify_modern_cuda.py"
SAM2_COMMIT="2b90b9f5ceec907a1c18123530e92e794ad901a4"

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
    "$CONDA" create --yes --name "$ENV_NAME" python=3.12 pip
fi

run_env() {
    "$CONDA" run -n "$ENV_NAME" "$@"
}

run_env python -m pip install --upgrade \
    pip \
    wheel \
    setuptools==69.5.1 \
    numpy==1.26.4
run_env python -m pip install \
    torch==2.10.0 \
    torchvision==0.25.0 \
    --index-url https://download.pytorch.org/whl/cu128

checkout_commit \
    https://github.com/facebookresearch/sam2.git \
    "$SAM2_COMMIT" \
    "$REPO_ROOT/sam2"

# The optional connected-components CUDA extension needs a matching nvcc
# toolkit. Meta documents that inference remains valid without it; only small
# hole/sprinkle post-processing is skipped in most cases.
run_env env SAM2_BUILD_CUDA=0 python -m pip install \
    --no-build-isolation \
    --editable "$REPO_ROOT/sam2"
run_env python -m pip install setuptools==69.5.1 numpy==1.26.4
run_env python "$VERIFY_SCRIPT"
run_env python -c 'from sam2.sam2_image_predictor import SAM2ImagePredictor; print("SAM2_IMPORT_OK")'
run_env python -m pip check
"$CONDA" list -n "$ENV_NAME" --explicit > "$LOCK_ROOT/${ENV_NAME}-conda-explicit.txt"
run_env python -m pip freeze > "$LOCK_ROOT/${ENV_NAME}-pip-freeze.txt"
git -C "$REPO_ROOT/sam2" rev-parse HEAD > "$LOCK_ROOT/sam2-head.txt"

echo "SAM 2.1 environment is ready without the optional CUDA extension."
