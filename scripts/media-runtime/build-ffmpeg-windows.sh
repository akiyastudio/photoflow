#!/usr/bin/env bash
set -euo pipefail

# Run from an MSYS2 UCRT64 shell. The GitHub workflow installs the exact toolchain.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_root="${PHOTOFLOW_MEDIA_WORK_ROOT:-$repo_root/.cache/media-runtime-build/ffmpeg}"
output_root="${PHOTOFLOW_MEDIA_OUTPUT_ROOT:-$repo_root/artifacts/installers/media-runtime}"
jobs="${NUMBER_OF_PROCESSORS:-4}"
host_system="$(uname -s)"
cross_flags=()
x264_cross_flags=()
x265_cross_flags=()
zlib_tool_prefix=""
objdump_command=objdump
if [[ "$host_system" == Linux* ]]; then
  jobs="${PHOTOFLOW_BUILD_JOBS:-$(nproc)}"
  cross_flags=(--enable-cross-compile --cross-prefix=x86_64-w64-mingw32-)
  x264_cross_flags=(--host=x86_64-w64-mingw32 --cross-prefix=x86_64-w64-mingw32-)
  x265_cross_flags=(
    -DCMAKE_SYSTEM_NAME=Windows
    -DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc
    -DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-g++
    -DCMAKE_RC_COMPILER=x86_64-w64-mingw32-windres
  )
  zlib_tool_prefix="x86_64-w64-mingw32-"
  objdump_command=x86_64-w64-mingw32-objdump
fi

resolved_work_root="$(realpath -m "$work_root")"
case "$resolved_work_root" in
  "$repo_root"/.cache/media-runtime-build/*) ;;
  *) echo "Refusing to clean unsafe FFmpeg work directory: $resolved_work_root" >&2; exit 1 ;;
esac
work_root="$resolved_work_root"

ffmpeg_commit="$(node -p "require('./media-runtime.lock.json').ffmpeg.commit")"
x264_commit="$(node -p "require('./media-runtime.lock.json').x264.commit")"
x265_commit="$(node -p "require('./media-runtime.lock.json').x265.commit")"
ffmpeg_repo="$(node -p "require('./media-runtime.lock.json').ffmpeg.repository")"
x264_repo="$(node -p "require('./media-runtime.lock.json').x264.repository")"
x265_repo="$(node -p "require('./media-runtime.lock.json').x265.repository")"
zlib_commit="$(node -p "require('./media-runtime.lock.json').zlib.commit")"
zlib_repo="$(node -p "require('./media-runtime.lock.json').zlib.repository")"

if [[ "${PHOTOFLOW_MEDIA_RESUME:-0}" != 1 ]]; then
  rm -rf "$work_root"
fi
mkdir -p "$work_root/src" "$work_root/prefix" "$work_root/package/runtime" "$work_root/package/licenses" "$work_root/package/source" "$output_root"

if [[ ! -d "$work_root/src/x264/.git" ]]; then
  git clone --filter=blob:none "$x264_repo" "$work_root/src/x264"
fi
git -C "$work_root/src/x264" checkout --detach "$x264_commit"
x264_flags=(
  --prefix="$work_root/prefix"
  --enable-static
  --disable-cli
  --disable-opencl
  "${x264_cross_flags[@]}"
)
printf '%s\n' "${x264_flags[@]}" > "$work_root/x264-configure-flags.txt"
if [[ ! -f "$work_root/prefix/lib/libx264.a" ]]; then
  pushd "$work_root/src/x264"
  ./configure "${x264_flags[@]}"
  cp config.mak "$work_root/x264-config.mak"
  make -j"$jobs"
  make install
  popd
elif [[ ! -f "$work_root/x264-config.mak" ]]; then
  cp "$work_root/src/x264/config.mak" "$work_root/x264-config.mak"
fi

if [[ ! -d "$work_root/src/x265/.git" ]]; then
  git clone --filter=blob:none "$x265_repo" "$work_root/src/x265"
fi
git -C "$work_root/src/x265" checkout --detach "$x265_commit"
x265_flags=(
  -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_INSTALL_PREFIX="$work_root/prefix"
  -DENABLE_SHARED=OFF
  -DENABLE_CLI=OFF
  -DENABLE_PIC=OFF
  "${x265_cross_flags[@]}"
)
printf '%s\n' "${x265_flags[@]}" > "$work_root/x265-cmake-flags.txt"
if [[ ! -f "$work_root/prefix/lib/libx265.a" ]]; then
  cmake -S "$work_root/src/x265/source" -B "$work_root/x265-build" "${x265_flags[@]}"
  cmake --build "$work_root/x265-build" --parallel "$jobs"
  cmake --install "$work_root/x265-build"
fi
x265_pkg_config="$work_root/prefix/lib/pkgconfig/x265.pc"
if [[ -f "$x265_pkg_config" ]]; then
  # x265 4.2 emits explicit shared libgcc entries even for a static build.
  # Use the static exception runtime so the packaged FFmpeg has no MinGW DLL dependency.
  sed -i 's/-lgcc_s/-lgcc_eh/g' "$x265_pkg_config"
fi

if [[ ! -d "$work_root/src/zlib/.git" ]]; then
  git clone --filter=blob:none "$zlib_repo" "$work_root/src/zlib"
fi
git -C "$work_root/src/zlib" checkout --detach "$zlib_commit"
if [[ ! -f "$work_root/prefix/lib/libz.a" ]]; then
  pushd "$work_root/src/zlib"
  make -f win32/Makefile.gcc PREFIX="$zlib_tool_prefix" -j"$jobs" libz.a
  mkdir -p "$work_root/prefix/include" "$work_root/prefix/lib"
  cp zlib.h zconf.h "$work_root/prefix/include/"
  cp libz.a "$work_root/prefix/lib/"
  popd
fi

if [[ ! -d "$work_root/src/ffmpeg/.git" ]]; then
  git clone --filter=blob:none "$ffmpeg_repo" "$work_root/src/ffmpeg"
fi
git -C "$work_root/src/ffmpeg" checkout --detach "$ffmpeg_commit"

ffmpeg_flags=(
  --prefix="$work_root/prefix"
  --arch=x86_64
  --target-os=mingw32
  "${cross_flags[@]}"
  --enable-gpl
  --enable-libx264
  --enable-libx265
  --enable-zlib
  --enable-mediafoundation
  --enable-d3d11va
  --enable-static
  --disable-shared
  --disable-autodetect
  --disable-network
  --disable-debug
  --disable-doc
  --disable-ffplay
  --disable-ffprobe
  --pkg-config=pkg-config
  --pkg-config-flags=--static
  --extra-cflags=-I$work_root/prefix/include
  "--extra-ldflags=-static -static-libgcc -static-libstdc++ -L$work_root/prefix/lib"
)
printf '%s\n' "${ffmpeg_flags[@]}" > "$work_root/configure-flags.txt"
pushd "$work_root/src/ffmpeg"
if [[ "${PHOTOFLOW_MEDIA_RESUME:-0}" == 1 && -f ffmpeg.exe ]]; then
  cp ffbuild/config.mak "$work_root/ffmpeg-config.mak"
else
  PKG_CONFIG_PATH="$work_root/prefix/lib/pkgconfig" ./configure "${ffmpeg_flags[@]}"
  cp ffbuild/config.mak "$work_root/ffmpeg-config.mak"
  make -j"$jobs" ffmpeg.exe
fi
popd

ffmpeg_exe="$work_root/src/ffmpeg/ffmpeg.exe"
test -f "$ffmpeg_exe"
configuration="$($ffmpeg_exe -hide_banner -buildconf 2>&1)"
for forbidden in --enable-nonfree --enable-libxvid --enable-avisynth --enable-librubberband; do
  if grep -Fq -- "$forbidden" <<<"$configuration"; then
    echo "Forbidden FFmpeg option detected: $forbidden" >&2
    exit 1
  fi
done
if "$objdump_command" -p "$ffmpeg_exe" | grep -Eiq 'DLL Name:.*(libwinpthread|libgcc|libstdc\+\+|x26[45])'; then
  echo 'FFmpeg unexpectedly depends on a non-system runtime DLL' >&2
  "$objdump_command" -p "$ffmpeg_exe" | grep -Ei 'DLL Name:' >&2
  exit 1
fi
for required in --enable-gpl --enable-libx264 --enable-libx265 --enable-zlib --enable-mediafoundation --enable-d3d11va --disable-autodetect --disable-network; do
  grep -Fq -- "$required" <<<"$configuration" || { echo "Missing FFmpeg option: $required" >&2; exit 1; }
done
"$ffmpeg_exe" -hide_banner -encoders 2>&1 | grep -Eq '^ V.* h264_mf ' || { echo 'Missing Media Foundation H.264 encoder' >&2; exit 1; }
"$ffmpeg_exe" -hide_banner -encoders 2>&1 | grep -Eq '^ V.* hevc_mf ' || { echo 'Missing Media Foundation H.265 encoder' >&2; exit 1; }
"$ffmpeg_exe" -hide_banner -encoders 2>&1 | grep -Eq '^ V.* libx265 ' || { echo 'Missing libx265 H.265 encoder' >&2; exit 1; }

# Exercise every command family used by the desktop app: H.264/AAC preview,
# H.265 CPU fallback, PNG frame extraction, and stream-copy segmentation.
mkdir -p "$work_root/smoke"
rm -f "$work_root/smoke/preview.mp4" "$work_root/smoke/hevc.mp4" "$work_root/smoke/frame.png" "$work_root/smoke"/part-*.mp4
smoke_runtime_root="$work_root/smoke"
if [[ "$host_system" == Linux* ]]; then
  smoke_runtime_root="$(wslpath -w "$work_root/smoke")"
fi
"$ffmpeg_exe" -y -v error -f lavfi -i testsrc2=size=320x180:rate=25 -f lavfi -i sine=frequency=1000 \
  -t 2 -c:v libx264 -pix_fmt yuv420p -c:a aac "$smoke_runtime_root/preview.mp4"
"$ffmpeg_exe" -y -v error -i "$smoke_runtime_root/preview.mp4" -t 1 -an \
  -c:v libx265 -preset ultrafast -x265-params log-level=error -pix_fmt yuv420p "$smoke_runtime_root/hevc.mp4"
"$ffmpeg_exe" -y -v error -ss 0.5 -i "$smoke_runtime_root/preview.mp4" -vf scale=160:-2 -frames:v 1 "$smoke_runtime_root/frame.png"
"$ffmpeg_exe" -y -v error -i "$smoke_runtime_root/preview.mp4" -c copy -map 0 -f segment -segment_time 1 "$smoke_runtime_root/part-%02d.mp4"

rm -rf "$work_root/package/runtime" "$work_root/package/licenses" "$work_root/package/source"
mkdir -p "$work_root/package/runtime" "$work_root/package/licenses" "$work_root/package/source/build-materials"

cp "$ffmpeg_exe" "$work_root/package/runtime/ffmpeg.exe"
cp "$work_root/src/ffmpeg/COPYING.GPLv2" "$work_root/package/runtime/COPYING.GPLv2"
cp "$work_root/src/x264/COPYING" "$work_root/package/runtime/COPYING.x264"
cp "$work_root/src/x265/COPYING" "$work_root/package/runtime/COPYING.x265"
cp "$work_root/src/zlib/LICENSE" "$work_root/package/runtime/LICENSE.zlib"
cp "$work_root/configure-flags.txt" "$work_root/package/runtime/configure-flags.txt"
cp "$repo_root/docs/legal/OPEN_SOURCE_NOTICES.html" "$work_root/package/runtime/OPEN_SOURCE_NOTICES.html"

cp "$work_root/src/ffmpeg/COPYING.GPLv2" "$work_root/package/licenses/FFmpeg-COPYING.GPLv2"
cp "$work_root/src/x264/COPYING" "$work_root/package/licenses/x264-COPYING"
cp "$work_root/src/x265/COPYING" "$work_root/package/licenses/x265-COPYING"
cp "$work_root/src/zlib/LICENSE" "$work_root/package/licenses/zlib-LICENSE"
cp "$repo_root/docs/legal/OPEN_SOURCE_NOTICES.html" "$work_root/package/licenses/OPEN_SOURCE_NOTICES.html"

git -C "$work_root/src/ffmpeg" archive --format=zip --output="$work_root/package/source/ffmpeg-$ffmpeg_commit.zip" HEAD
git -C "$work_root/src/x264" archive --format=zip --output="$work_root/package/source/x264-$x264_commit.zip" HEAD
git -C "$work_root/src/x265" archive --format=zip --output="$work_root/package/source/x265-$x265_commit.zip" HEAD
git -C "$work_root/src/zlib" archive --format=zip --output="$work_root/package/source/zlib-$zlib_commit.zip" HEAD
cp "$repo_root/media-runtime.lock.json" "$work_root/package/source/build-materials/media-runtime.lock.json"
cp "$repo_root/scripts/media-runtime/build-ffmpeg-windows.sh" "$work_root/package/source/build-materials/build-ffmpeg-windows.sh"
cp "$repo_root/scripts/media-runtime/create-ffmpeg-manifest.cjs" "$work_root/package/source/build-materials/create-ffmpeg-manifest.cjs"
cp "$repo_root/scripts/media-runtime/runtime-policy.cjs" "$work_root/package/source/build-materials/runtime-policy.cjs"
cp "$repo_root/.github/workflows/build-media-runtime.yml" "$work_root/package/source/build-materials/build-media-runtime.yml"
cp "$work_root/configure-flags.txt" "$work_root/package/source/build-materials/configure-flags.txt"
cp "$work_root/ffmpeg-config.mak" "$work_root/package/source/build-materials/ffmpeg-config.mak"
cp "$work_root/x264-configure-flags.txt" "$work_root/package/source/build-materials/x264-configure-flags.txt"
cp "$work_root/x264-config.mak" "$work_root/package/source/build-materials/x264-config.mak"
cp "$work_root/x265-cmake-flags.txt" "$work_root/package/source/build-materials/x265-cmake-flags.txt"
git -C "$work_root/src/ffmpeg" diff --binary > "$work_root/package/source/build-materials/ffmpeg-changes.diff"
git -C "$work_root/src/x264" diff --binary > "$work_root/package/source/build-materials/x264-changes.diff"
git -C "$work_root/src/x265" diff --binary > "$work_root/package/source/build-materials/x265-changes.diff"
git -C "$work_root/src/zlib" diff --binary > "$work_root/package/source/build-materials/zlib-changes.diff"
if command -v pacman >/dev/null 2>&1; then
  pacman -Q > "$work_root/package/source/build-materials/msys2-packages.txt"
else
  dpkg-query -W -f='${binary:Package}\t${Version}\n' > "$work_root/package/source/build-materials/ubuntu-packages.txt"
fi

zip_directory() {
  local source="$1"
  local destination="$2"
  local source_win destination_win
  rm -f "$destination"
  if [[ "$host_system" == Linux* ]]; then
    (cd "$source" && zip -q -9 -r "$destination" .)
  else
    source_win="$(cygpath -w "$source")"
    destination_win="$(cygpath -w "$destination")"
    powershell.exe -NoLogo -NoProfile -NonInteractive -Command \
      "Compress-Archive -CompressionLevel Optimal -Path '$source_win\\*' -DestinationPath '$destination_win' -Force"
  fi
}

zip_directory "$work_root/package/runtime" "$output_root/ffmpeg-runtime-windows-x64.zip"
zip_directory "$work_root/package/source" "$output_root/ffmpeg-corresponding-source.zip"
zip_directory "$work_root/package/licenses" "$output_root/ffmpeg-licenses.zip"
node "$repo_root/scripts/media-runtime/create-ffmpeg-manifest.cjs" "$output_root" "$work_root/configure-flags.txt"
node "$repo_root/scripts/media-runtime/verify-runtime.cjs" ffmpeg "$output_root"
echo "FFmpeg runtime and GPL compliance bundle created in $output_root"
