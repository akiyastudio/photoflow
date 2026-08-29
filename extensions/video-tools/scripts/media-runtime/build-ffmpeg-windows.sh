#!/usr/bin/env bash
set -euo pipefail

# Run from an MSYS2 UCRT64 shell. The GitHub workflow installs the exact toolchain.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
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
ffmpeg_mirror_repo="$(node -p "require('./media-runtime.lock.json').ffmpeg.mirrorRepository")"
x264_repo="$(node -p "require('./media-runtime.lock.json').x264.repository")"
x264_mirror_repo="$(node -p "require('./media-runtime.lock.json').x264.mirrorRepository")"
x265_repo="$(node -p "require('./media-runtime.lock.json').x265.repository")"
zlib_commit="$(node -p "require('./media-runtime.lock.json').zlib.commit")"
zlib_repo="$(node -p "require('./media-runtime.lock.json').zlib.repository")"
nv_codec_headers_commit="$(node -p "require('./media-runtime.lock.json').nvCodecHeaders.commit")"
nv_codec_headers_repo="$(node -p "require('./media-runtime.lock.json').nvCodecHeaders.repository")"
zimg_commit="$(node -p "require('./media-runtime.lock.json').zimg.commit")"
zimg_repo="$(node -p "require('./media-runtime.lock.json').zimg.repository")"
freetype_commit="$(node -p "require('./media-runtime.lock.json').mpvDependencies.freetype.commit")"
freetype_repo="$(node -p "require('./media-runtime.lock.json').mpvDependencies.freetype.repository")"
fribidi_commit="$(node -p "require('./media-runtime.lock.json').mpvDependencies.fribidi.commit")"
fribidi_repo="$(node -p "require('./media-runtime.lock.json').mpvDependencies.fribidi.repository")"
harfbuzz_commit="$(node -p "require('./media-runtime.lock.json').mpvDependencies.harfbuzz.commit")"
harfbuzz_repo="$(node -p "require('./media-runtime.lock.json').mpvDependencies.harfbuzz.repository")"
libass_commit="$(node -p "require('./media-runtime.lock.json').mpvDependencies.libass.commit")"
libass_repo="$(node -p "require('./media-runtime.lock.json').mpvDependencies.libass.repository")"

if [[ "${PHOTOFLOW_MEDIA_RESUME:-0}" != 1 ]]; then
  rm -rf "$work_root"
fi
mkdir -p "$work_root/src" "$work_root/prefix" "$work_root/package/runtime" "$work_root/package/licenses" "$work_root/package/source" "$output_root"

if [[ ! -d "$work_root/src/x264/.git" ]]; then
  if ! git clone --filter=blob:none "$x264_repo" "$work_root/src/x264"; then
    # code.videolan.org occasionally rejects CI downloads. The GitHub mirror
    # carries the same commit IDs; checkout below still enforces the lock file.
    rm -rf "$work_root/src/x264"
    git clone --filter=blob:none "$x264_mirror_repo" "$work_root/src/x264"
  fi
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
x265_common_flags=(
  -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_INSTALL_PREFIX="$work_root/prefix"
  -DENABLE_SHARED=OFF
  -DENABLE_CLI=OFF
  -DENABLE_PIC=OFF
  "${x265_cross_flags[@]}"
)
{
  printf '%s\n' '[10-bit]' "${x265_common_flags[@]}" -DHIGH_BIT_DEPTH=ON -DEXPORT_C_API=OFF
  printf '%s\n' '[8-bit-linked]' "${x265_common_flags[@]}" -DLINKED_10BIT=ON -DEXTRA_LIB=x265_main10.a "-DEXTRA_LINK_FLAGS=-L$work_root/prefix/lib"
} > "$work_root/x265-cmake-flags.txt"
if [[ ! -f "$work_root/prefix/lib/libx265.a" ]]; then
  cmake -S "$work_root/src/x265/source" -B "$work_root/x265-build-10" "${x265_common_flags[@]}" \
    -DHIGH_BIT_DEPTH=ON -DEXPORT_C_API=OFF
  cmake --build "$work_root/x265-build-10" --parallel "$jobs"
  cp "$work_root/x265-build-10/libx265.a" "$work_root/prefix/lib/libx265_main10.a"
  cmake -S "$work_root/src/x265/source" -B "$work_root/x265-build" "${x265_common_flags[@]}" \
    -DLINKED_10BIT=ON -DEXTRA_LIB=x265_main10.a "-DEXTRA_LINK_FLAGS=-L$work_root/prefix/lib"
  cmake --build "$work_root/x265-build" --parallel "$jobs"
  cmake --install "$work_root/x265-build"
fi
x265_pkg_config="$work_root/prefix/lib/pkgconfig/x265.pc"
if [[ -f "$x265_pkg_config" ]]; then
  # x265 4.2 emits explicit shared libgcc entries even for a static build.
  # Use the static exception runtime so the packaged FFmpeg has no MinGW DLL dependency.
  sed -i 's/-lgcc_s/-lgcc_eh/g' "$x265_pkg_config"
  grep -Fq -- '-lx265_main10' "$x265_pkg_config" || sed -i 's/^Libs.private:/Libs.private: -lx265_main10/' "$x265_pkg_config"
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
cat > "$work_root/prefix/lib/pkgconfig/zlib.pc" <<EOF
prefix=$work_root/prefix
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include
Name: zlib
Description: zlib compression library
Version: $(node -p "require('./media-runtime.lock.json').zlib.version")
Libs: -L\${libdir} -lz
Cflags: -I\${includedir}
EOF

clone_locked_dependency() {
  local name="$1" repository="$2" commit="$3" destination="$4"
  if [[ ! -d "$destination/.git" ]]; then git clone --filter=blob:none "$repository" "$destination"; fi
  git -C "$destination" checkout --force --detach "$commit"
  [[ "$(git -C "$destination" rev-parse HEAD)" == "$commit" ]] || { echo "$name checkout mismatch" >&2; exit 1; }
}
clone_locked_dependency zimg "$zimg_repo" "$zimg_commit" "$work_root/src/zimg"
clone_locked_dependency freetype "$freetype_repo" "$freetype_commit" "$work_root/src/freetype"
clone_locked_dependency fribidi "$fribidi_repo" "$fribidi_commit" "$work_root/src/fribidi"
clone_locked_dependency harfbuzz "$harfbuzz_repo" "$harfbuzz_commit" "$work_root/src/harfbuzz"
clone_locked_dependency libass "$libass_repo" "$libass_commit" "$work_root/src/libass"

apply_locked_patch() {
  local directory="$1" patch_file="$2"
  if patch --forward --dry-run --silent --batch -d "$directory" -p1 -i "$patch_file" >/dev/null 2>&1; then
    patch --forward --silent --batch -d "$directory" -p1 -i "$patch_file"
  elif ! patch --reverse --dry-run --silent --batch -d "$directory" -p1 -i "$patch_file" >/dev/null 2>&1; then
    echo "Locked source patch does not apply cleanly: $patch_file" >&2
    exit 1
  fi
}
apply_locked_patch "$work_root/src/libass" "$repo_root/scripts/media-runtime/patches/libass-disable-iconv.patch"
apply_locked_patch "$work_root/src/freetype" "$repo_root/scripts/media-runtime/patches/freetype-disable-bzip2.patch"

export PKG_CONFIG_PATH="$work_root/prefix/lib/pkgconfig:$work_root/prefix/share/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
if [[ ! -f "$work_root/prefix/lib/libfreetype.a" ]]; then
  meson setup "$work_root/freetype-build" "$work_root/src/freetype" --buildtype=release --default-library=static --prefix="$work_root/prefix" \
    -Dauto_features=disabled -Dzlib=system -Dbzip2=disabled -Dpng=disabled -Dbrotli=disabled -Dharfbuzz=disabled -Dtests=disabled
  meson compile -C "$work_root/freetype-build" -j "$jobs"
  meson install -C "$work_root/freetype-build"
fi
if [[ ! -f "$work_root/prefix/lib/libfribidi.a" ]]; then
  meson setup "$work_root/fribidi-build" "$work_root/src/fribidi" --buildtype=release --default-library=static --prefix="$work_root/prefix" \
    -Ddocs=false -Dbin=false -Dtests=false -Ddeprecated=true
  meson compile -C "$work_root/fribidi-build" -j "$jobs"
  meson install -C "$work_root/fribidi-build"
fi
if [[ ! -f "$work_root/prefix/lib/libharfbuzz.a" ]]; then
  meson setup "$work_root/harfbuzz-build" "$work_root/src/harfbuzz" --buildtype=release --default-library=static --prefix="$work_root/prefix" \
    -Dauto_features=disabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled -Dicu=disabled \
    -Dgraphite=disabled -Dgraphite2=disabled -Dfreetype=disabled -Dgdi=disabled -Ddirectwrite=disabled \
    -Dtests=disabled -Dintrospection=disabled -Ddocs=disabled -Dutilities=disabled -Dbenchmark=disabled
  meson compile -C "$work_root/harfbuzz-build" -j "$jobs"
  meson install -C "$work_root/harfbuzz-build"
fi
if [[ ! -f "$work_root/prefix/lib/libass.a" ]]; then
  meson setup "$work_root/libass-build" "$work_root/src/libass" --buildtype=release --default-library=static --prefix="$work_root/prefix" \
    -Dauto_features=disabled -Dfontconfig=disabled -Ddirectwrite=enabled -Dcoretext=disabled -Dlibunibreak=disabled \
    -Dasm=enabled -Dtest=disabled -Dcompare=disabled -Dprofile=disabled -Dfuzz=disabled -Dcheckasm=disabled
  meson compile -C "$work_root/libass-build" -j "$jobs"
  meson install -C "$work_root/libass-build"
fi
if [[ ! -f "$work_root/prefix/lib/libzimg.a" ]]; then
  pushd "$work_root/src/zimg"
  ./autogen.sh
  ./configure --prefix="$work_root/prefix" --enable-static --disable-shared
  make -j"$jobs"
  make install
  popd
fi

if [[ ! -d "$work_root/src/ffmpeg/.git" ]]; then
  if ! git clone --filter=blob:none "$ffmpeg_repo" "$work_root/src/ffmpeg"; then
    rm -rf "$work_root/src/ffmpeg"
    git clone --filter=blob:none "$ffmpeg_mirror_repo" "$work_root/src/ffmpeg"
  fi
fi
git -C "$work_root/src/ffmpeg" checkout --detach "$ffmpeg_commit"

if [[ ! -d "$work_root/src/nv-codec-headers/.git" ]]; then
  git clone --filter=blob:none "$nv_codec_headers_repo" "$work_root/src/nv-codec-headers"
fi
git -C "$work_root/src/nv-codec-headers" checkout --detach "$nv_codec_headers_commit"
# nv-codec-headers is header-only. Installing it into the private prefix lets
# FFmpeg expose NVENC without requiring the CUDA toolkit or shipping an extra DLL.
make -C "$work_root/src/nv-codec-headers" PREFIX="$work_root/prefix" install

ffmpeg_flags=(
  --prefix="$work_root/prefix"
  --arch=x86_64
  --target-os=mingw32
  "${cross_flags[@]}"
  --enable-gpl
  --enable-libx264
  --enable-libx265
  --enable-libass
  --enable-libzimg
  --enable-zlib
  --enable-mediafoundation
  --enable-d3d11va
  --enable-ffnvcodec
  --enable-nvenc
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
for required in --enable-gpl --enable-libx264 --enable-libx265 --enable-libass --enable-libzimg --enable-zlib --enable-mediafoundation --enable-d3d11va --enable-ffnvcodec --enable-nvenc --disable-autodetect --disable-network; do
  grep -Fq -- "$required" <<<"$configuration" || { echo "Missing FFmpeg option: $required" >&2; exit 1; }
done
"$ffmpeg_exe" -hide_banner -encoders 2>&1 | grep -Eq '^ V.* h264_mf ' || { echo 'Missing Media Foundation H.264 encoder' >&2; exit 1; }
"$ffmpeg_exe" -hide_banner -encoders 2>&1 | grep -Eq '^ V.* hevc_mf ' || { echo 'Missing Media Foundation H.265 encoder' >&2; exit 1; }
"$ffmpeg_exe" -hide_banner -encoders 2>&1 | grep -Eq '^ V.* h264_nvenc ' || { echo 'Missing NVIDIA NVENC H.264 encoder' >&2; exit 1; }
"$ffmpeg_exe" -hide_banner -encoders 2>&1 | grep -Eq '^ V.* hevc_nvenc ' || { echo 'Missing NVIDIA NVENC H.265 encoder' >&2; exit 1; }
"$ffmpeg_exe" -hide_banner -encoders 2>&1 | grep -Eq '^ V.* libx265 ' || { echo 'Missing libx265 H.265 encoder' >&2; exit 1; }
"$ffmpeg_exe" -hide_banner -encoders 2>&1 | grep -Eq '^ V.* av1_nvenc ' || { echo 'Missing NVIDIA NVENC AV1 encoder' >&2; exit 1; }
"$ffmpeg_exe" -hide_banner -filters 2>&1 | grep -Eq '^ ... zscale ' || { echo 'Missing zscale HDR filter' >&2; exit 1; }
"$ffmpeg_exe" -hide_banner -filters 2>&1 | grep -Eq '^ ... subtitles ' || { echo 'Missing subtitles burn-in filter' >&2; exit 1; }
"$ffmpeg_exe" -hide_banner -h encoder=libx265 2>&1 | grep -Eq 'Supported pixel formats:.*yuv420p10le' || { echo 'Missing x265 10-bit interface' >&2; exit 1; }

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
"$ffmpeg_exe" -y -v error -f lavfi -i testsrc2=size=320x180:rate=25 -t 1 -an \
  -vf "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc" \
  -c:v libx265 -preset ultrafast -x265-params log-level=error -pix_fmt yuv420p10le \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc "$smoke_runtime_root/hevc-main10.mp4"
"$ffmpeg_exe" -y -v error -i "$smoke_runtime_root/hevc-main10.mp4" -t 1 -an \
  -vf "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=2,zscale=t=bt709:m=bt709:r=tv,format=yuv420p" \
  -c:v libx264 -preset ultrafast "$smoke_runtime_root/hdr-to-sdr.mp4"
printf '1\n00:00:00,000 --> 00:00:00,800\nPhotoFlow subtitle burn test\n' > "$work_root/smoke/test.srt"
subtitle_filter_path="$work_root/smoke/test.srt"
if [[ "$host_system" != Linux* ]]; then subtitle_filter_path="$(cygpath -m "$subtitle_filter_path")"; fi
subtitle_filter_path="${subtitle_filter_path/:/\\:}"
"$ffmpeg_exe" -y -v error -i "$smoke_runtime_root/preview.mp4" -t 1 -an \
  -vf "subtitles='$subtitle_filter_path'" -c:v libx264 -preset ultrafast "$smoke_runtime_root/subtitle-burn.mp4"
"$ffmpeg_exe" -y -v error -ss 0.5 -i "$smoke_runtime_root/preview.mp4" -vf scale=160:-2 -frames:v 1 "$smoke_runtime_root/frame.png"
"$ffmpeg_exe" -y -v error -i "$smoke_runtime_root/preview.mp4" -c copy -map 0 -f segment -segment_time 1 "$smoke_runtime_root/part-%02d.mp4"

rm -rf "$work_root/package/runtime" "$work_root/package/licenses" "$work_root/package/source"
mkdir -p "$work_root/package/runtime" "$work_root/package/licenses" "$work_root/package/source/build-materials"

cp "$ffmpeg_exe" "$work_root/package/runtime/ffmpeg.exe"
cp "$work_root/src/ffmpeg/COPYING.GPLv2" "$work_root/package/runtime/COPYING.GPLv2"
cp "$work_root/src/x264/COPYING" "$work_root/package/runtime/COPYING.x264"
cp "$work_root/src/x265/COPYING" "$work_root/package/runtime/COPYING.x265"
cp "$work_root/src/zlib/LICENSE" "$work_root/package/runtime/LICENSE.zlib"
cp "$work_root/src/zimg/COPYING" "$work_root/package/runtime/LICENSE.zimg"
cp "$work_root/src/libass/COPYING" "$work_root/package/runtime/LICENSE.libass"
cp "$work_root/src/freetype/LICENSE.TXT" "$work_root/package/runtime/LICENSE.freetype"
cp "$work_root/src/fribidi/COPYING" "$work_root/package/runtime/LICENSE.fribidi"
cp "$work_root/src/harfbuzz/COPYING" "$work_root/package/runtime/LICENSE.harfbuzz"
# The repository has no standalone LICENSE file; preserve the MIT notice from
# the NVENC API header in both redistributable license bundles.
sed -n '1,/^ \*\/$/p' "$work_root/src/nv-codec-headers/include/ffnvcodec/nvEncodeAPI.h" > "$work_root/package/runtime/LICENSE.nv-codec-headers"
cp "$work_root/configure-flags.txt" "$work_root/package/runtime/configure-flags.txt"
cp "$repo_root/LICENSES/README.md" "$work_root/package/runtime/OPEN_SOURCE_NOTICES.md"

cp "$work_root/src/ffmpeg/COPYING.GPLv2" "$work_root/package/licenses/FFmpeg-COPYING.GPLv2"
cp "$work_root/src/x264/COPYING" "$work_root/package/licenses/x264-COPYING"
cp "$work_root/src/x265/COPYING" "$work_root/package/licenses/x265-COPYING"
cp "$work_root/src/zlib/LICENSE" "$work_root/package/licenses/zlib-LICENSE"
cp "$work_root/src/zimg/COPYING" "$work_root/package/licenses/zimg-COPYING"
cp "$work_root/src/libass/COPYING" "$work_root/package/licenses/libass-COPYING"
cp "$work_root/src/freetype/LICENSE.TXT" "$work_root/package/licenses/freetype-LICENSE"
cp "$work_root/src/fribidi/COPYING" "$work_root/package/licenses/fribidi-COPYING"
cp "$work_root/src/harfbuzz/COPYING" "$work_root/package/licenses/harfbuzz-COPYING"
cp "$work_root/package/runtime/LICENSE.nv-codec-headers" "$work_root/package/licenses/nv-codec-headers-LICENSE"
cp "$repo_root/LICENSES/README.md" "$work_root/package/licenses/OPEN_SOURCE_NOTICES.md"

git -C "$work_root/src/ffmpeg" archive --format=zip --output="$work_root/package/source/ffmpeg-$ffmpeg_commit.zip" HEAD
git -C "$work_root/src/x264" archive --format=zip --output="$work_root/package/source/x264-$x264_commit.zip" HEAD
git -C "$work_root/src/x265" archive --format=zip --output="$work_root/package/source/x265-$x265_commit.zip" HEAD
git -C "$work_root/src/zlib" archive --format=zip --output="$work_root/package/source/zlib-$zlib_commit.zip" HEAD
git -C "$work_root/src/nv-codec-headers" archive --format=zip --output="$work_root/package/source/nv-codec-headers-$nv_codec_headers_commit.zip" HEAD
git -C "$work_root/src/zimg" archive --format=zip --output="$work_root/package/source/zimg-$zimg_commit.zip" HEAD
git -C "$work_root/src/freetype" archive --format=zip --output="$work_root/package/source/freetype-$freetype_commit.zip" HEAD
git -C "$work_root/src/fribidi" archive --format=zip --output="$work_root/package/source/fribidi-$fribidi_commit.zip" HEAD
git -C "$work_root/src/harfbuzz" archive --format=zip --output="$work_root/package/source/harfbuzz-$harfbuzz_commit.zip" HEAD
git -C "$work_root/src/libass" archive --format=zip --output="$work_root/package/source/libass-$libass_commit.zip" HEAD
cp "$repo_root/media-runtime.lock.json" "$work_root/package/source/build-materials/media-runtime.lock.json"
cp "$repo_root/scripts/media-runtime/build-ffmpeg-windows.sh" "$work_root/package/source/build-materials/build-ffmpeg-windows.sh"
cp "$repo_root/scripts/media-runtime/create-ffmpeg-manifest.cjs" "$work_root/package/source/build-materials/create-ffmpeg-manifest.cjs"
cp "$repo_root/scripts/media-runtime/runtime-policy.cjs" "$work_root/package/source/build-materials/runtime-policy.cjs"
cp "$repo_root/scripts/media-runtime/build-media-runtime.yml" "$work_root/package/source/build-materials/build-media-runtime.yml"
cp "$work_root/configure-flags.txt" "$work_root/package/source/build-materials/configure-flags.txt"
cp "$work_root/ffmpeg-config.mak" "$work_root/package/source/build-materials/ffmpeg-config.mak"
cp "$work_root/x264-configure-flags.txt" "$work_root/package/source/build-materials/x264-configure-flags.txt"
cp "$work_root/x264-config.mak" "$work_root/package/source/build-materials/x264-config.mak"
cp "$work_root/x265-cmake-flags.txt" "$work_root/package/source/build-materials/x265-cmake-flags.txt"
# Ignore checkout-only CRLF conversion when a Windows Git installation has a
# global core.autocrlf policy; real source changes remain recorded.
git -C "$work_root/src/ffmpeg" diff --binary --ignore-space-at-eol > "$work_root/package/source/build-materials/ffmpeg-changes.diff"
git -C "$work_root/src/x264" diff --binary --ignore-space-at-eol > "$work_root/package/source/build-materials/x264-changes.diff"
git -C "$work_root/src/x265" diff --binary --ignore-space-at-eol > "$work_root/package/source/build-materials/x265-changes.diff"
git -C "$work_root/src/zlib" diff --binary --ignore-space-at-eol > "$work_root/package/source/build-materials/zlib-changes.diff"
git -C "$work_root/src/nv-codec-headers" diff --binary --ignore-space-at-eol > "$work_root/package/source/build-materials/nv-codec-headers-changes.diff"
git -C "$work_root/src/zimg" diff --binary --ignore-space-at-eol > "$work_root/package/source/build-materials/zimg-changes.diff"
git -C "$work_root/src/freetype" diff --binary --ignore-space-at-eol > "$work_root/package/source/build-materials/freetype-changes.diff"
git -C "$work_root/src/fribidi" diff --binary --ignore-space-at-eol > "$work_root/package/source/build-materials/fribidi-changes.diff"
git -C "$work_root/src/harfbuzz" diff --binary --ignore-space-at-eol > "$work_root/package/source/build-materials/harfbuzz-changes.diff"
git -C "$work_root/src/libass" diff --binary --ignore-space-at-eol > "$work_root/package/source/build-materials/libass-changes.diff"
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
