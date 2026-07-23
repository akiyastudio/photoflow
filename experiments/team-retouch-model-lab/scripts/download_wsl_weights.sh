#!/usr/bin/env bash
set -euo pipefail

CONDA="$HOME/miniforge3/bin/conda"
LAB_ROOT="$HOME/model-lab"
TARGET="${1:-all}"

download_pairdetr() {
    mkdir -p "$LAB_ROOT/checkpoints/pairdetr"
    "$CONDA" run -n pairdetr hf download MTSAIR/PairDETR \
        --local-dir "$LAB_ROOT/checkpoints/pairdetr"
}

download_sam3() {
    if ! "$CONDA" run -n sam3 hf auth whoami >/dev/null 2>&1; then
        echo "SAM 3 requires an accepted Hugging Face access request and 'hf auth login' in the sam3 environment." >&2
        exit 5
    fi
    mkdir -p "$LAB_ROOT/checkpoints/sam3"
    "$CONDA" run -n sam3 hf download facebook/sam3 \
        --local-dir "$LAB_ROOT/checkpoints/sam3"
}

download_sam2() {
    local destination="$LAB_ROOT/checkpoints/sam2/sam2.1_hiera_large.pt"
    local url="https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt"
    mkdir -p "$(dirname "$destination")"
    if [ ! -s "$destination" ]; then
        curl --fail --location --retry 5 --continue-at - \
            --output "$destination" "$url"
    fi
}

case "$TARGET" in
    pairdetr)
        download_pairdetr
        ;;
    sam3)
        download_sam3
        ;;
    sam2)
        download_sam2
        ;;
    all)
        download_pairdetr
        download_sam3
        ;;
    *)
        echo "Usage: $0 [pairdetr|sam2|sam3|all]" >&2
        exit 2
        ;;
esac

find "$LAB_ROOT/checkpoints" -type f -print0 | sort -z | xargs -0 sha256sum > "$LAB_ROOT/env-locks/checkpoint-sha256.txt"
