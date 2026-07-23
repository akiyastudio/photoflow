#!/usr/bin/env bash
set -euo pipefail

CONDA="$HOME/miniforge3/bin/conda"
ENV_NAME="openmmlab-export"
LAB_ROOT="$HOME/model-lab"
REPO_ROOT="$LAB_ROOT/repos"
LOCK_ROOT="$LAB_ROOT/env-locks"

MMDEPLOY_COMMIT="bc75c9d6c8940aa03d0e1e5b5962bd930478ba77"
MMDET_COMMIT="44ebd17b145c2372c4b700bfb9cb20dbd28ab64a"

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
    torch==2.1.0 \
    torchvision==0.16.0 \
    --index-url https://download.pytorch.org/whl/cu121
run_env python -m pip install \
    numpy==1.26.4 \
    protobuf==3.20.2 \
    onnx==1.15.0 \
    onnxruntime==1.16.3 \
    opencv-python==4.10.0.84
run_env python -m pip install \
    https://download.openmmlab.com/mmcv/dist/cu121/torch2.1.0/mmcv-2.1.0-cp310-cp310-manylinux1_x86_64.whl
run_env python -m pip install \
    'mmengine>=0.10.3,<1' \
    mmdet==3.3.0 \
    mmdeploy==1.3.1
run_env python -m pip uninstall --yes opencv-python-headless
run_env python -m pip install --force-reinstall \
    numpy==1.26.4 \
    opencv-python==4.10.0.84

MMDEPLOY_PACKAGE_ROOT="$(run_env python -c 'from pathlib import Path; import mmdeploy; print(Path(mmdeploy.__file__).resolve().parent)' | tail -n 1)"
MMDEPLOY_CPU_PATCH="/mnt/c/dev/app2/experiments/team-retouch-model-lab/patches/mmdeploy-1.3.1-rtmdet-ins-cpu-grid-priors.patch"
MMDEPLOY_RTMDET_REWRITE="$MMDEPLOY_PACKAGE_ROOT/codebase/mmdet/models/dense_heads/rtmdet_ins_head.py"
if ! grep -q 'device=mask_feat.device' "$MMDEPLOY_RTMDET_REWRITE"; then
    patch --batch --forward --strip=1 --directory="$MMDEPLOY_PACKAGE_ROOT" < "$MMDEPLOY_CPU_PATCH"
fi
grep -q 'device=mask_feat.device' "$MMDEPLOY_RTMDET_REWRITE"

checkout_commit \
    https://github.com/open-mmlab/mmdeploy.git \
    "$MMDEPLOY_COMMIT" \
    "$REPO_ROOT/mmdeploy"
checkout_commit \
    https://github.com/open-mmlab/mmdetection.git \
    "$MMDET_COMMIT" \
    "$REPO_ROOT/mmdetection"

run_env python -c 'import cv2, mmcv, mmdeploy, mmdet, mmengine, numpy, onnx, onnxruntime; assert numpy.__version__ == "1.26.4"; assert cv2.__version__ == "4.10.0"; print(mmcv.__version__, mmdeploy.__version__, mmdet.__version__, mmengine.__version__, numpy.__version__, cv2.__version__, onnx.__version__, onnxruntime.__version__)'
run_env python -m pip check
"$CONDA" list -n "$ENV_NAME" --explicit > "$LOCK_ROOT/${ENV_NAME}-conda-explicit.txt"
run_env python -m pip freeze > "$LOCK_ROOT/${ENV_NAME}-pip-freeze.txt"
git -C "$REPO_ROOT/mmdeploy" rev-parse HEAD > "$LOCK_ROOT/mmdeploy-head.txt"
git -C "$REPO_ROOT/mmdetection" rev-parse HEAD > "$LOCK_ROOT/mmdetection-head.txt"

echo "OpenMMLab export environment is ready. Export must use --device cpu."
