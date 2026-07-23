#!/usr/bin/env bash
set -euo pipefail

WINDOWS_WORKSPACE="${1:-/mnt/c/dev/app2}"
CONDA="$HOME/miniforge3/bin/conda"
ENV_NAME="openmmlab-export"
LAB_ROOT="$HOME/model-lab"
MMDEPLOY_ROOT="$LAB_ROOT/repos/mmdeploy"
MMDET_ROOT="$LAB_ROOT/repos/mmdetection"

DEPLOY_CONFIG="$MMDEPLOY_ROOT/configs/mmdet/instance-seg/instance-seg_rtmdet-ins_onnxruntime_static-640x640.py"
MODEL_CONFIG="$MMDET_ROOT/configs/rtmdet/rtmdet-ins_m_8xb32-300e_coco.py"
CHECKPOINT="$WINDOWS_WORKSPACE/.model-lab/models/plan1/rtmdet-ins/rtmdet-ins_m_8xb32-300e_coco_20221123_001039-6eba602e.pth"
SAMPLE_IMAGE="$MMDET_ROOT/demo/demo.jpg"
WORK_DIR="$WINDOWS_WORKSPACE/.model-lab/models/plan1/rtmdet-ins/onnx-export"
STABLE_ONNX="$WINDOWS_WORKSPACE/.model-lab/models/plan1/rtmdet-ins/rtmdet-ins_m_640x640.onnx"

for required in "$CONDA" "$DEPLOY_CONFIG" "$MODEL_CONFIG" "$CHECKPOINT" "$SAMPLE_IMAGE"; do
    if [ ! -e "$required" ]; then
        echo "Missing required export input: $required" >&2
        exit 2
    fi
done

mkdir -p "$WORK_DIR"
set +e
CUDA_VISIBLE_DEVICES="" "$CONDA" run -n "$ENV_NAME" \
    python "$MMDEPLOY_ROOT/tools/deploy.py" \
    "$DEPLOY_CONFIG" \
    "$MODEL_CONFIG" \
    "$CHECKPOINT" \
    "$SAMPLE_IMAGE" \
    --work-dir "$WORK_DIR" \
    --device cpu \
    --dump-info
DEPLOY_EXIT=$?
set -e

if [ ! -s "$WORK_DIR/end2end.onnx" ]; then
    echo "MMDeploy did not produce end2end.onnx (exit $DEPLOY_EXIT)" >&2
    exit 3
fi

"$CONDA" run -n "$ENV_NAME" python -c \
    'import onnx, sys; model = onnx.load(sys.argv[1]); onnx.checker.check_model(model); print("ONNX_CHECK_OK", len(model.graph.node))' \
    "$WORK_DIR/end2end.onnx"
if [ "$DEPLOY_EXIT" -ne 0 ]; then
    echo "MMDeploy export succeeded; its optional result visualization failed with exit $DEPLOY_EXIT." >&2
fi

install -m 0644 "$WORK_DIR/end2end.onnx" "$STABLE_ONNX"
sha256sum "$STABLE_ONNX" > "${STABLE_ONNX}.sha256"
echo "RTMDet-Ins ONNX: $STABLE_ONNX"
