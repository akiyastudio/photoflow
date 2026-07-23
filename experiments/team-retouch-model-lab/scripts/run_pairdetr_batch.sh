#!/usr/bin/env bash
set -euo pipefail

INPUT_DIR="${1:?Usage: $0 INPUT_DIR OUTPUT_DIR}"
OUTPUT_DIR="${2:?Usage: $0 INPUT_DIR OUTPUT_DIR}"
THRESHOLD="${3:-0.50}"
PYTHON="$HOME/miniforge3/envs/pairdetr/bin/python"
SCRIPT="/mnt/c/dev/app2/experiments/team-retouch-model-lab/scripts/smoke_pairdetr.py"

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
    echo "IMAGE=$filename"
    "$PYTHON" "$SCRIPT" \
        --image "$image" \
        --pair-threshold "$THRESHOLD" \
        --boxes-output "$OUTPUT_DIR/${stem}-boxes.json"
done
