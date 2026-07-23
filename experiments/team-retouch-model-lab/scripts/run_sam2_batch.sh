#!/usr/bin/env bash
set -euo pipefail

INPUT_DIR="${1:?Usage: $0 INPUT_DIR BOX_DIR OUTPUT_DIR}"
BOX_DIR="${2:?Usage: $0 INPUT_DIR BOX_DIR OUTPUT_DIR}"
OUTPUT_DIR="${3:?Usage: $0 INPUT_DIR BOX_DIR OUTPUT_DIR}"
PYTHON="$HOME/miniforge3/envs/sam2/bin/python"
SCRIPT="/mnt/c/dev/app2/experiments/team-retouch-model-lab/scripts/smoke_sam2.py"

mkdir -p "$OUTPUT_DIR"
shopt -s nullglob
images=("$INPUT_DIR"/*.jpg "$INPUT_DIR"/*.jpeg "$INPUT_DIR"/*.png)
if [ "${#images[@]}" -eq 0 ]; then
    echo "No input images found in $INPUT_DIR" >&2
    exit 2
fi

for image in "${images[@]}"; do
    filename="$(basename "$image")"
    stem="${filename%.*}"
    boxes="$BOX_DIR/${stem}-boxes.json"
    test -s "$boxes"
    echo "IMAGE=$filename"
    "$PYTHON" "$SCRIPT" \
        --image "$image" \
        --boxes "$boxes" \
        --output-dir "$OUTPUT_DIR/$stem"
done
