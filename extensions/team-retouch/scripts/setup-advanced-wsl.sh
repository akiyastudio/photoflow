#!/usr/bin/env bash
# Plugin-owned advanced runtime helper.
set -euo pipefail

CONDA="$HOME/miniforge3/bin/conda"
LAB_ROOT="$HOME/model-lab"
REPO_ROOT="$LAB_ROOT/repos"
CHECKPOINT_ROOT="$LAB_ROOT/checkpoints"
LOCK_ROOT="$LAB_ROOT/env-locks"
RELEASE_LOCK_ROOT="$LAB_ROOT/release-locks"
PAIRDETR_COMMIT="fbcdebdff44bb5e9e6a9d92240ff01f8eec30ebc"
SAM2_COMMIT="2b90b9f5ceec907a1c18123530e92e794ad901a4"
SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVIEWED_LOCK_ROOT="$SCRIPT_ROOT/../advanced/locks"
for lock in pairdetr-requirements.lock sam2-requirements.lock checkpoints.sha256; do
    test -s "$REVIEWED_LOCK_ROOT/$lock" || { printf 'Missing reviewed advanced lock: %s\n' "$REVIEWED_LOCK_ROOT/$lock" >&2; exit 1; }
done

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
mkdir -p "$REPO_ROOT" "$CHECKPOINT_ROOT" "$LOCK_ROOT" "$RELEASE_LOCK_ROOT"
install -m 0444 "$REVIEWED_LOCK_ROOT/checkpoints.sha256" "$RELEASE_LOCK_ROOT/checkpoints.sha256"

log "Creating PairDETR environment"
if ! "$CONDA" run -n pairdetr python -c 'import sys' >/dev/null 2>&1; then
    "$CONDA" create --yes --name pairdetr python=3.12 pip=25.3 wheel=0.45.1 setuptools=69.5.1
fi
"$CONDA" run -n pairdetr python -m pip install --require-hashes --no-deps -r "$REVIEWED_LOCK_ROOT/pairdetr-requirements.lock"
checkout_commit https://github.com/mts-ai/pairdetr.git "$PAIRDETR_COMMIT" "$REPO_ROOT/pairdetr"
mkdir -p "$CHECKPOINT_ROOT/pairdetr"
"$CONDA" run -n pairdetr hf download MTSAIR/PairDETR --local-dir "$CHECKPOINT_ROOT/pairdetr"
test -s "$CHECKPOINT_ROOT/pairdetr/pytorch_model.bin"
PYTHONPATH="$CHECKPOINT_ROOT/pairdetr" "$CONDA" run -n pairdetr python -c \
    'import torch; from hf_utils import PairDetr, forward; assert torch.cuda.is_available(); print("PAIRDETR_CUDA_OK", torch.cuda.get_device_name(0))'

log "Creating SAM 2.1 environment"
if ! "$CONDA" run -n sam2 python -c 'import sys' >/dev/null 2>&1; then
    "$CONDA" create --yes --name sam2 python=3.12 pip=25.3 wheel=0.45.1 setuptools=69.5.1 numpy=1.26.4
fi
"$CONDA" run -n sam2 python -m pip install --require-hashes --no-deps -r "$REVIEWED_LOCK_ROOT/sam2-requirements.lock"
checkout_commit https://github.com/facebookresearch/sam2.git "$SAM2_COMMIT" "$REPO_ROOT/sam2"
"$CONDA" run -n sam2 env SAM2_BUILD_CUDA=0 python -m pip install \
    --no-deps --no-build-isolation --editable "$REPO_ROOT/sam2"
mkdir -p "$CHECKPOINT_ROOT/sam2"
curl --fail --location --retry 5 --continue-at - \
    --output "$CHECKPOINT_ROOT/sam2/sam2.1_hiera_large.pt" \
    https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt
test -s "$CHECKPOINT_ROOT/sam2/sam2.1_hiera_large.pt"
(
    cd "$LAB_ROOT"
    sha256sum --check --strict "$RELEASE_LOCK_ROOT/checkpoints.sha256"
)
"$CONDA" run -n sam2 python -c \
    'import torch; from sam2.sam2_image_predictor import SAM2ImagePredictor; assert torch.cuda.is_available(); print("SAM2_CUDA_OK", torch.cuda.get_device_name(0))'

log "Running release-gating model self-tests"
timeout 180 "$HOME/miniforge3/envs/pairdetr/bin/python" "$SCRIPT_ROOT/../advanced/pairdetr_service.py" --self-test >/dev/null
timeout 240 "$HOME/miniforge3/envs/sam2/bin/python" "$SCRIPT_ROOT/../advanced/sam2_service.py" --self-test >/dev/null
receipt_tmp="$LOCK_ROOT/.self-test-receipt.json.tmp"
printf '{"version":1,"pairDetr":true,"sam2":true,"completedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$receipt_tmp"
chmod 0444 "$receipt_tmp"
mv -f "$receipt_tmp" "$LOCK_ROOT/self-test-receipt.json"

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
