#!/usr/bin/env bash
set -euo pipefail

# Builds the complete release-ready libmpv runtime. By default it first builds
# a pinned LGPL-compatible dependency prefix; advanced callers may still pass
# their own audited prefix and compliance archives through the LGPL_* variables.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${MPV_SOURCE_ROOT:-$repo_root/.cache/media-runtime-build/mpv/src}"
build_root="${MPV_BUILD_ROOT:-$repo_root/.cache/media-runtime-build/mpv/build}"
output_root="${PHOTOFLOW_MPV_OUTPUT_ROOT:-$repo_root/artifacts/installers/media-runtime/libmpv-lgpl-windows-x64}"
dependency_root="${PHOTOFLOW_MPV_DEPENDENCY_ROOT:-$repo_root/.cache/media-runtime-build/mpv-dependencies}"
if [[ -z "${LGPL_PREFIX:-}" ]]; then
  bash "$repo_root/scripts/media-runtime/build-libmpv-dependencies-windows.sh"
  prefix="$dependency_root/prefix"
  dependency_sources="$dependency_root/artifacts/dependency-corresponding-source.zip"
  dependency_licenses="$dependency_root/artifacts/dependency-licenses.zip"
  ffmpeg_commit="$(node -p "require('./media-runtime.lock.json').ffmpeg.commit")"
else
  prefix="$LGPL_PREFIX"
  dependency_sources="${LGPL_DEPENDENCY_SOURCE_ARCHIVE:?Set LGPL_DEPENDENCY_SOURCE_ARCHIVE when LGPL_PREFIX is provided}"
  dependency_licenses="${LGPL_DEPENDENCY_LICENSE_ARCHIVE:?Set LGPL_DEPENDENCY_LICENSE_ARCHIVE when LGPL_PREFIX is provided}"
  ffmpeg_commit="${LGPL_FFMPEG_COMMIT:?Set LGPL_FFMPEG_COMMIT when LGPL_PREFIX is provided}"
fi
mpv_ref="$(node -p "require('./media-runtime.lock.json').mpv.ref")"
mpv_repo="$(node -p "require('./media-runtime.lock.json').mpv.repository")"
mpv_commit="$(node -p "require('./media-runtime.lock.json').mpv.commit")"
bootstrap_source_archive="${PHOTOFLOW_MPV_BOOTSTRAP_SOURCE_ARCHIVE:-}"
bootstrap_license_archive="${PHOTOFLOW_MPV_BOOTSTRAP_LICENSE_ARCHIVE:-}"
bootstrap_manifest="${PHOTOFLOW_MPV_BOOTSTRAP_MANIFEST:-}"

source_root="$(realpath -m "$source_root")"
build_root="$(realpath -m "$build_root")"
output_root="$(realpath -m "$output_root")"
case "$source_root" in "$repo_root"/.cache/media-runtime-build/*) ;; *) echo "Refusing to clean unsafe mpv source directory: $source_root" >&2; exit 1 ;; esac
case "$build_root" in "$repo_root"/.cache/media-runtime-build/*) ;; *) echo "Refusing to clean unsafe mpv build directory: $build_root" >&2; exit 1 ;; esac
case "$output_root" in "$repo_root"/artifacts/installers/media-runtime/*) ;; *) echo "Refusing to clean unsafe mpv output directory: $output_root" >&2; exit 1 ;; esac

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
if [[ "${PHOTOFLOW_MPV_RESUME:-0}" != 1 ]]; then
  rm -rf "$source_root" "$build_root" "$output_root"
fi
if [[ -n "$bootstrap_source_archive" && ! -d "$source_root" ]]; then
  bootstrap_source_archive="$(realpath "$bootstrap_source_archive")"
  bootstrap_license_archive="$(realpath "${bootstrap_license_archive:?Set PHOTOFLOW_MPV_BOOTSTRAP_LICENSE_ARCHIVE with the bootstrap source archive}")"
  bootstrap_manifest="$(realpath "${bootstrap_manifest:?Set PHOTOFLOW_MPV_BOOTSTRAP_MANIFEST with the bootstrap archives}")"
  node "$repo_root/scripts/media-runtime/verify-bootstrap-archives.cjs" \
    "$bootstrap_manifest" "$bootstrap_source_archive" "$bootstrap_license_archive"
  bootstrap_extract_root="$build_root-bootstrap-source"
  rm -rf "$bootstrap_extract_root"
  mkdir -p "$bootstrap_extract_root" "$source_root"
  bsdtar -xf "$bootstrap_source_archive" -C "$bootstrap_extract_root"
  test -f "$bootstrap_extract_root/mpv/MPV_VERSION" || { echo 'Bootstrap archive is missing mpv source' >&2; exit 1; }
  cp -a "$bootstrap_extract_root/mpv/." "$source_root/"
fi
if [[ -z "$bootstrap_source_archive" && ! -d "$source_root/.git" ]]; then
  git clone --branch "$mpv_ref" --depth 1 "$mpv_repo" "$source_root"
fi
actual_mpv_commit="$mpv_commit"
if [[ -z "$bootstrap_source_archive" ]]; then
  actual_mpv_commit="$(git -C "$source_root" rev-parse HEAD)"
fi
[[ "$actual_mpv_commit" == "$mpv_commit"* ]] || { echo "mpv tag resolved to unexpected commit: $actual_mpv_commit" >&2; exit 1; }
mkdir -p "$build_root" "$output_root"

shaderc_pkg_config_dir="${PHOTOFLOW_SHADERC_PKG_CONFIG_DIR:-/ucrt64/lib/pkgconfig}"
shaderc_runtime_dll="${PHOTOFLOW_SHADERC_RUNTIME_DLL:-/ucrt64/bin/libshaderc_shared.dll}"
test -f "$shaderc_pkg_config_dir/shaderc.pc" || { echo "Missing shaderc pkg-config metadata: $shaderc_pkg_config_dir/shaderc.pc" >&2; exit 1; }
test -f "$shaderc_runtime_dll" || { echo "Missing shaderc runtime: $shaderc_runtime_dll" >&2; exit 1; }
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig:$shaderc_pkg_config_dir"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
export PATH="$prefix/bin:$PATH"
export LDFLAGS="-static-libgcc -static-libstdc++"
mpv_options=(
  -Dgpl=false
  -Dlibmpv=true
  -Dcplayer=false
  -Dbuild-date=false
  -Dtests=false
  -Dauto_features=disabled
  -Dwasapi=enabled
  -Dd3d11=enabled
  -Dd3d-hwaccel=enabled
  -Dd3d9-hwaccel=enabled
  -Dwin32-threads=enabled
  -Dzlib=enabled
  -Dgl=disabled
  -Dvulkan=disabled
  -Dshaderc=enabled
  -Dspirv-cross=enabled
)
printf '%s\n' "${mpv_options[@]}" > "$build_root-meson-options.txt"
if [[ ! -f "$build_root/build.ninja" ]]; then
  meson setup "$build_root" "$source_root" \
    --buildtype=release \
    --prefix="$output_root" \
    "${mpv_options[@]}"
fi
meson compile -C "$build_root"
meson install -C "$build_root"
meson configure "$build_root" > "$output_root/meson-configure.txt"
cp "$build_root-meson-options.txt" "$output_root/mpv-meson-options.txt"
grep -Eq '^[[:space:]]*gpl[[:space:]]+false' "$output_root/meson-configure.txt" || { echo 'mpv gpl=false was not preserved' >&2; exit 1; }

find "$build_root" -type f \( -iname 'libmpv-2.dll' -o -iname 'mpv-2.dll' \) -exec cp {} "$output_root/libmpv-2.dll" \;
test -f "$output_root/libmpv-2.dll" || { echo 'Meson build did not produce libmpv-2.dll' >&2; exit 1; }
find "$prefix/bin" -maxdepth 1 -type f -iname '*.dll' -exec cp -f {} "$output_root/" \;
cp "$shaderc_runtime_dll" "$output_root/libshaderc_shared.dll"
for binary in "$output_root"/*.dll; do
  if objdump -p "$binary" | grep -Eiq 'DLL Name:.*(libwinpthread|libgcc|libstdc\+\+)'; then
    echo "Runtime contains an undeclared MinGW support DLL dependency: $binary" >&2
    objdump -p "$binary" | grep -Ei 'DLL Name:' >&2
    exit 1
  fi
done
cp "$source_root/Copyright" "$output_root/mpv-Copyright"
cp "$repo_root/extensions/video-playback-mpv/LICENSES.md" "$output_root/PhotoFlow-LICENSES.md"
cp "$repo_root/media-runtime.lock.json" "$output_root/media-runtime.lock.json"
printf '%s\n' "$ffmpeg_configuration" > "$output_root/linked-ffmpeg-buildconf.txt"
printf '%s\n' "$ffmpeg_version" > "$output_root/linked-ffmpeg-version.txt"
printf '%s\n' "$ffmpeg_commit" > "$output_root/linked-ffmpeg-commit.txt"
printf '%s\n' "$actual_mpv_commit" > "$output_root/mpv-commit.txt"

compliance_root="$build_root/compliance"
mkdir -p "$compliance_root/source/mpv" "$compliance_root/source/build-materials" "$compliance_root/licenses"
if [[ -n "$bootstrap_source_archive" ]]; then
  cp -a "$source_root/." "$compliance_root/source/mpv/"
else
  git -C "$source_root" archive HEAD | tar -x -C "$compliance_root/source/mpv"
fi
cp "$dependency_sources" "$compliance_root/source/dependency-corresponding-source.zip"
cp "$repo_root/scripts/media-runtime/build-libmpv-lgpl-windows.sh" "$compliance_root/source/build-materials/build-libmpv-lgpl-windows.sh"
cp "$repo_root/scripts/media-runtime/build-libmpv-dependencies-windows.sh" "$compliance_root/source/build-materials/build-libmpv-dependencies-windows.sh"
cp "$repo_root/scripts/media-runtime/verify-bootstrap-archives.cjs" "$compliance_root/source/build-materials/verify-bootstrap-archives.cjs"
mkdir -p "$compliance_root/source/build-materials/patches"
cp "$repo_root/scripts/media-runtime/patches/"*.patch "$compliance_root/source/build-materials/patches/"
cp "$output_root/meson-configure.txt" "$compliance_root/source/build-materials/meson-configure.txt"
cp "$output_root/mpv-meson-options.txt" "$compliance_root/source/build-materials/mpv-meson-options.txt"
cp "$output_root/linked-ffmpeg-buildconf.txt" "$compliance_root/source/build-materials/linked-ffmpeg-buildconf.txt"
cp "$output_root/linked-ffmpeg-version.txt" "$compliance_root/source/build-materials/linked-ffmpeg-version.txt"
cp "$output_root/linked-ffmpeg-commit.txt" "$compliance_root/source/build-materials/linked-ffmpeg-commit.txt"
cp "$repo_root/media-runtime.lock.json" "$compliance_root/source/build-materials/media-runtime.lock.json"
cp "$source_root/Copyright" "$compliance_root/licenses/mpv-Copyright"
cp "$dependency_licenses" "$compliance_root/licenses/dependency-licenses.zip"
cp "$repo_root/extensions/video-playback-mpv/LICENSES.md" "$compliance_root/licenses/PhotoFlow-LICENSES.md"

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
