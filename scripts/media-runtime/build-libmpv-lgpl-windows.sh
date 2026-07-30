#!/usr/bin/env bash
set -euo pipefail

# Builds libmpv itself. LGPL-compatible FFmpeg/libass/libplacebo and their
# transitive DLLs must already be present in LGPL_PREFIX; this script rejects
# a prefix whose FFmpeg was built with GPL or nonfree options.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${MPV_SOURCE_ROOT:-$repo_root/.media-runtime-build/mpv/src}"
build_root="${MPV_BUILD_ROOT:-$repo_root/.media-runtime-build/mpv/build}"
output_root="${PHOTOFLOW_MPV_OUTPUT_ROOT:-$repo_root/release/media-runtime/libmpv-lgpl-windows-x64}"
prefix="${LGPL_PREFIX:?Set LGPL_PREFIX to the Windows x64 LGPL dependency prefix}"
dependency_sources="${LGPL_DEPENDENCY_SOURCE_ARCHIVE:?Set LGPL_DEPENDENCY_SOURCE_ARCHIVE to the exact FFmpeg/libass/libplacebo dependency sources}"
dependency_licenses="${LGPL_DEPENDENCY_LICENSE_ARCHIVE:?Set LGPL_DEPENDENCY_LICENSE_ARCHIVE to the dependency license bundle}"
ffmpeg_commit="${LGPL_FFMPEG_COMMIT:?Set LGPL_FFMPEG_COMMIT to the full 40-character commit used for the linked FFmpeg}"
mpv_ref="$(node -p "require('./media-runtime.lock.json').mpv.ref")"
mpv_repo="$(node -p "require('./media-runtime.lock.json').mpv.repository")"
mpv_commit="$(node -p "require('./media-runtime.lock.json').mpv.commit")"

source_root="$(realpath -m "$source_root")"
build_root="$(realpath -m "$build_root")"
output_root="$(realpath -m "$output_root")"
case "$source_root" in "$repo_root"/.media-runtime-build/*) ;; *) echo "Refusing to clean unsafe mpv source directory: $source_root" >&2; exit 1 ;; esac
case "$build_root" in "$repo_root"/.media-runtime-build/*) ;; *) echo "Refusing to clean unsafe mpv build directory: $build_root" >&2; exit 1 ;; esac
case "$output_root" in "$repo_root"/release/media-runtime/*) ;; *) echo "Refusing to clean unsafe mpv output directory: $output_root" >&2; exit 1 ;; esac

ffmpeg_bin="$prefix/bin/ffmpeg.exe"
test -x "$ffmpeg_bin" || { echo "Missing LGPL FFmpeg at $ffmpeg_bin" >&2; exit 1; }
[[ "$ffmpeg_commit" =~ ^[0-9a-fA-F]{40}$ ]] || { echo 'LGPL_FFMPEG_COMMIT must be a full 40-character commit' >&2; exit 1; }
ffmpeg_configuration="$($ffmpeg_bin -hide_banner -buildconf 2>&1)"
ffmpeg_version="$($ffmpeg_bin -version | sed -n '1s/^ffmpeg version \([^ ]*\).*/\1/p')"
test -n "$ffmpeg_version" || { echo 'Unable to determine linked FFmpeg version' >&2; exit 1; }
for forbidden in --enable-gpl --enable-nonfree --enable-libx264 --enable-libx265 --enable-libxvid --enable-avisynth --enable-librubberband; do
  if grep -Fq -- "$forbidden" <<<"$ffmpeg_configuration"; then
    echo "LGPL libmpv dependency prefix contains forbidden FFmpeg option: $forbidden" >&2
    exit 1
  fi
done
for required in --disable-gpl --disable-nonfree; do
  grep -Fq -- "$required" <<<"$ffmpeg_configuration" || { echo "LGPL FFmpeg is missing explicit option: $required" >&2; exit 1; }
done

test -f "$dependency_sources" || { echo "Missing dependency source archive: $dependency_sources" >&2; exit 1; }
test -f "$dependency_licenses" || { echo "Missing dependency license archive: $dependency_licenses" >&2; exit 1; }
rm -rf "$source_root" "$build_root" "$output_root"
git clone --branch "$mpv_ref" --depth 1 "$mpv_repo" "$source_root"
actual_mpv_commit="$(git -C "$source_root" rev-parse HEAD)"
[[ "$actual_mpv_commit" == "$mpv_commit"* ]] || { echo "mpv tag resolved to unexpected commit: $actual_mpv_commit" >&2; exit 1; }
mkdir -p "$build_root" "$output_root"

export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
export PATH="$prefix/bin:$PATH"
meson setup "$build_root" "$source_root" \
  --buildtype=release \
  --prefix="$output_root" \
  -Dgpl=false \
  -Dlibmpv=true \
  -Dcplayer=false \
  -Dbuild-date=false \
  -Dtests=false
meson compile -C "$build_root"
meson install -C "$build_root"
meson configure "$build_root" > "$output_root/meson-configure.txt"
grep -Eq '^gpl[[:space:]]+false' "$output_root/meson-configure.txt" || { echo 'mpv gpl=false was not preserved' >&2; exit 1; }

find "$build_root" -type f \( -iname 'libmpv-2.dll' -o -iname 'mpv-2.dll' \) -exec cp {} "$output_root/libmpv-2.dll" \;
test -f "$output_root/libmpv-2.dll" || { echo 'Meson build did not produce libmpv-2.dll' >&2; exit 1; }
find "$prefix/bin" -maxdepth 1 -type f -iname '*.dll' -exec cp -n {} "$output_root/" \;
cp "$source_root/Copyright" "$output_root/mpv-Copyright"
cp "$repo_root/components/video-playback-mpv/LICENSES.md" "$output_root/PhotoFlow-LICENSES.md"
cp "$repo_root/media-runtime.lock.json" "$output_root/media-runtime.lock.json"
printf '%s\n' "$ffmpeg_configuration" > "$output_root/linked-ffmpeg-buildconf.txt"
printf '%s\n' "$ffmpeg_version" > "$output_root/linked-ffmpeg-version.txt"
printf '%s\n' "$ffmpeg_commit" > "$output_root/linked-ffmpeg-commit.txt"
printf '%s\n' "$actual_mpv_commit" > "$output_root/mpv-commit.txt"

compliance_root="$build_root/compliance"
mkdir -p "$compliance_root/source/mpv" "$compliance_root/source/build-materials" "$compliance_root/licenses"
git -C "$source_root" archive HEAD | tar -x -C "$compliance_root/source/mpv"
cp "$dependency_sources" "$compliance_root/source/dependency-corresponding-source.zip"
cp "$repo_root/scripts/media-runtime/build-libmpv-lgpl-windows.sh" "$compliance_root/source/build-materials/build-libmpv-lgpl-windows.sh"
cp "$output_root/meson-configure.txt" "$compliance_root/source/build-materials/meson-configure.txt"
cp "$output_root/linked-ffmpeg-buildconf.txt" "$compliance_root/source/build-materials/linked-ffmpeg-buildconf.txt"
cp "$output_root/linked-ffmpeg-version.txt" "$compliance_root/source/build-materials/linked-ffmpeg-version.txt"
cp "$output_root/linked-ffmpeg-commit.txt" "$compliance_root/source/build-materials/linked-ffmpeg-commit.txt"
cp "$repo_root/media-runtime.lock.json" "$compliance_root/source/build-materials/media-runtime.lock.json"
cp "$source_root/Copyright" "$compliance_root/licenses/mpv-Copyright"
cp "$dependency_licenses" "$compliance_root/licenses/dependency-licenses.zip"
cp "$repo_root/components/video-playback-mpv/LICENSES.md" "$compliance_root/licenses/PhotoFlow-LICENSES.md"

zip_directory() {
  local source="$1"
  local destination="$2"
  local source_win destination_win
  source_win="$(cygpath -w "$source")"
  destination_win="$(cygpath -w "$destination")"
  powershell.exe -NoLogo -NoProfile -NonInteractive -Command \
    "Compress-Archive -CompressionLevel Optimal -Path '$source_win\\*' -DestinationPath '$destination_win' -Force"
}
zip_directory "$compliance_root/source" "$output_root/libmpv-lgpl-corresponding-source.zip"
zip_directory "$compliance_root/licenses" "$output_root/libmpv-lgpl-licenses.zip"
node "$repo_root/scripts/media-runtime/create-mpv-manifest.cjs" "$output_root"
node "$repo_root/scripts/media-runtime/verify-runtime.cjs" mpv "$output_root"
echo "libmpv was built and verified with -Dgpl=false and an LGPL-only dependency prefix."
echo "Output: $output_root"
