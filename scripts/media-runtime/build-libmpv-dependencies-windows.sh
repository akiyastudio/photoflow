#!/usr/bin/env bash
set -euo pipefail

# Builds the complete, pinned LGPL-compatible dependency prefix used by
# build-libmpv-lgpl-windows.sh. Run from an MSYS2 UCRT64 shell.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_root="${PHOTOFLOW_MPV_DEPENDENCY_ROOT:-$repo_root/.media-runtime-build/mpv-dependencies}"
jobs="${NUMBER_OF_PROCESSORS:-4}"

work_root="$(realpath -m "$work_root")"
case "$work_root" in
  "$repo_root"/.media-runtime-build/*) ;;
  *) echo "Refusing to clean unsafe dependency directory: $work_root" >&2; exit 1 ;;
esac

prefix="$work_root/prefix"
source_root="$work_root/src"
build_root="$work_root/build"
artifact_root="$work_root/artifacts"
package_root="$work_root/package"
lock_value() {
  node -p "require('./media-runtime.lock.json')$1"
}

ffmpeg_repo="${PHOTOFLOW_FFMPEG_REPOSITORY_OVERRIDE:-$(lock_value '.ffmpeg.repository')}"
ffmpeg_commit="$(lock_value '.ffmpeg.commit')"
zlib_repo="$(lock_value '.zlib.repository')"
zlib_commit="$(lock_value '.zlib.commit')"

dependency_names=(freetype fribidi harfbuzz libass spirvCross libplacebo)
declare -A dependency_dirs=(
  [freetype]=freetype
  [fribidi]=fribidi
  [harfbuzz]=harfbuzz
  [libass]=libass
  [spirvCross]=spirv-cross
  [libplacebo]=libplacebo
)

if [[ "${PHOTOFLOW_MPV_DEPENDENCY_RESUME:-0}" != 1 ]]; then
  rm -rf "$work_root"
fi
mkdir -p "$prefix/include" "$prefix/lib/pkgconfig" "$source_root" "$build_root" "$artifact_root"

clone_locked() {
  local name="$1" repo="$2" commit="$3" destination="$4"
  if [[ ! -d "$destination/.git" ]]; then
    local attempt
    for attempt in 1 2 3; do
      rm -rf "$destination"
      if git clone --filter=blob:none "$repo" "$destination"; then
        break
      fi
      if [[ "$attempt" == 3 ]]; then
        echo "Failed to clone $name after $attempt attempts" >&2
        return 1
      fi
      sleep 2
    done
  fi
  git -C "$destination" checkout --detach "$commit"
  local actual
  actual="$(git -C "$destination" rev-parse HEAD)"
  [[ "$actual" == "$commit" ]] || {
    echo "$name resolved to unexpected commit: $actual" >&2
    exit 1
  }
  if [[ "$name" == libplacebo ]]; then
    git -C "$destination" submodule update --init --depth 1 3rdparty/jinja 3rdparty/markupsafe
  fi
}

clone_locked ffmpeg "$ffmpeg_repo" "$ffmpeg_commit" "$source_root/ffmpeg"
clone_locked zlib "$zlib_repo" "$zlib_commit" "$source_root/zlib"
for name in "${dependency_names[@]}"; do
  repo="$(lock_value ".mpvDependencies.$name.repository")"
  commit="$(lock_value ".mpvDependencies.$name.commit")"
  clone_locked "$name" "$repo" "$commit" "$source_root/${dependency_dirs[$name]}"
done

export PKG_CONFIG_PATH="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
export CFLAGS="-O2"
export CXXFLAGS="-O2"
winpthread_archive="$(cygpath -m /ucrt64/lib/libwinpthread.a)"
export LDFLAGS="-static-libgcc -static-libstdc++ -Wl,--whole-archive,$winpthread_archive,--no-whole-archive"

pushd "$source_root/zlib"
make -f win32/Makefile.gcc PREFIX= -j"$jobs" libz.a
cp zlib.h zconf.h "$prefix/include/"
cp libz.a "$prefix/lib/"
popd
cat > "$prefix/lib/pkgconfig/zlib.pc" <<EOF
prefix=$prefix
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: zlib
Description: zlib compression library
Version: $(lock_value '.zlib.version')
Libs: -L\${libdir} -lz
Cflags: -I\${includedir}
EOF

meson setup "$build_root/freetype" "$source_root/freetype" \
  --buildtype=release --default-library=shared --prefix="$prefix" \
  -Dauto_features=disabled -Dzlib=external -Dbzip2=disabled -Dpng=disabled \
  -Dbrotli=disabled -Dharfbuzz=disabled -Dtests=disabled
meson compile -C "$build_root/freetype" -j "$jobs"
meson install -C "$build_root/freetype"

meson setup "$build_root/fribidi" "$source_root/fribidi" \
  --buildtype=release --default-library=shared --prefix="$prefix" \
  -Ddocs=false -Dbin=false -Dtests=false -Ddeprecated=true
meson compile -C "$build_root/fribidi" -j "$jobs"
meson install -C "$build_root/fribidi"

meson setup "$build_root/harfbuzz" "$source_root/harfbuzz" \
  --buildtype=release --default-library=shared --prefix="$prefix" \
  -Dauto_features=disabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled \
  -Dchafa=disabled -Dicu=disabled -Dgraphite=disabled -Dgraphite2=disabled \
  -Dfreetype=disabled -Dgdi=disabled -Ddirectwrite=disabled -Dtests=disabled \
  -Dintrospection=disabled -Ddocs=disabled -Dutilities=disabled -Dbenchmark=disabled
meson compile -C "$build_root/harfbuzz" -j "$jobs"
meson install -C "$build_root/harfbuzz"

meson setup "$build_root/libass" "$source_root/libass" \
  --buildtype=release --default-library=shared --prefix="$prefix" \
  -Dauto_features=disabled -Dfontconfig=disabled -Ddirectwrite=enabled \
  -Dcoretext=disabled -Dlibunibreak=disabled -Dasm=enabled -Dtest=disabled \
  -Dcompare=disabled -Dprofile=disabled -Dfuzz=disabled -Dcheckasm=disabled
meson compile -C "$build_root/libass" -j "$jobs"
meson install -C "$build_root/libass"

cmake -S "$source_root/spirv-cross" -B "$build_root/spirv-cross" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_SHARED_LINKER_FLAGS="-static-libgcc -static-libstdc++ -Wl,--whole-archive,$winpthread_archive,--no-whole-archive" \
  "-DCMAKE_C_STANDARD_LIBRARIES=-l:libwinpthread.a" \
  "-DCMAKE_CXX_STANDARD_LIBRARIES=-l:libwinpthread.a" \
  -DSPIRV_CROSS_CLI=OFF -DSPIRV_CROSS_ENABLE_TESTS=OFF \
  -DSPIRV_CROSS_STATIC=OFF -DSPIRV_CROSS_SHARED=ON
cmake --build "$build_root/spirv-cross" --parallel "$jobs"
cmake --install "$build_root/spirv-cross"

meson setup "$build_root/libplacebo" "$source_root/libplacebo" \
  --buildtype=release --default-library=shared --prefix="$prefix" \
  -Dauto_features=disabled -Dvulkan=disabled -Dopengl=disabled -Dd3d11=enabled \
  -Dglslang=disabled -Dshaderc=disabled -Dlcms=disabled -Ddovi=disabled \
  -Dlibdovi=disabled -Dunwind=disabled -Dxxhash=disabled \
  -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false
meson compile -C "$build_root/libplacebo" -j "$jobs"
meson install -C "$build_root/libplacebo"

ffmpeg_flags=(
  --prefix="$prefix"
  --arch=x86_64
  --target-os=mingw32
  --enable-shared
  --disable-static
  --disable-gpl
  --disable-version3
  --disable-nonfree
  --enable-zlib
  --enable-mediafoundation
  --enable-d3d11va
  --enable-dxva2
  --enable-w32threads
  --disable-autodetect
  --disable-network
  --disable-debug
  --disable-doc
  --disable-ffplay
  --disable-ffprobe
  --pkg-config=pkg-config
  --extra-cflags=-I$prefix/include
  "--extra-ldflags=-static-libgcc -static-libstdc++ -L$prefix/lib"
  --extra-libs=-l:libwinpthread.a
)
printf '%s\n' "${ffmpeg_flags[@]}" > "$work_root/ffmpeg-configure-flags.txt"
pushd "$source_root/ffmpeg"
./configure "${ffmpeg_flags[@]}"
cp ffbuild/config.mak "$work_root/ffmpeg-config.mak"
make -j"$jobs"
make install
popd

ffmpeg_exe="$prefix/bin/ffmpeg.exe"
test -x "$ffmpeg_exe" || { echo "FFmpeg build did not produce $ffmpeg_exe" >&2; exit 1; }
ffmpeg_configuration="$($ffmpeg_exe -hide_banner -buildconf 2>&1)"
for required in --disable-gpl --disable-nonfree --enable-shared --enable-d3d11va --enable-dxva2; do
  grep -Fq -- "$required" <<<"$ffmpeg_configuration" || {
    echo "LGPL FFmpeg is missing required option: $required" >&2
    exit 1
  }
done
for forbidden in --enable-gpl --enable-nonfree --enable-libx264 --enable-libx265 --enable-libxvid --enable-avisynth --enable-librubberband; do
  if grep -Fq -- "$forbidden" <<<"$ffmpeg_configuration"; then
    echo "LGPL FFmpeg contains forbidden option: $forbidden" >&2
    exit 1
  fi
done

rm -rf "$package_root"
mkdir -p "$package_root/source/build-materials" "$package_root/licenses"
git -C "$source_root/ffmpeg" archive --format=zip --output="$package_root/source/ffmpeg-$ffmpeg_commit.zip" HEAD
git -C "$source_root/zlib" archive --format=zip --output="$package_root/source/zlib-$zlib_commit.zip" HEAD
for name in "${dependency_names[@]}"; do
  directory="${dependency_dirs[$name]}"
  commit="$(lock_value ".mpvDependencies.$name.commit")"
  git -C "$source_root/$directory" archive --format=zip --output="$package_root/source/$directory-$commit.zip" HEAD
done
mkdir -p "$package_root/source/libplacebo-build-submodules"
for submodule in 3rdparty/jinja 3rdparty/markupsafe; do
  submodule_name="${submodule//\//-}"
  submodule_commit="$(git -C "$source_root/libplacebo/$submodule" rev-parse HEAD)"
  git -C "$source_root/libplacebo/$submodule" archive --format=zip \
    --output="$package_root/source/libplacebo-build-submodules/$submodule_name-$submodule_commit.zip" HEAD
done

cp "$repo_root/media-runtime.lock.json" "$package_root/source/build-materials/media-runtime.lock.json"
cp "$repo_root/scripts/media-runtime/build-libmpv-dependencies-windows.sh" "$package_root/source/build-materials/"
cp "$work_root/ffmpeg-configure-flags.txt" "$work_root/ffmpeg-config.mak" "$package_root/source/build-materials/"
if command -v pacman >/dev/null 2>&1; then
  pacman -Q > "$package_root/source/build-materials/msys2-packages.txt"
fi
for directory in ffmpeg zlib "${dependency_dirs[@]}"; do
  git -C "$source_root/$directory" diff --binary > "$package_root/source/build-materials/$directory-changes.diff"
done

cp "$source_root/ffmpeg/COPYING.LGPLv2.1" "$package_root/licenses/FFmpeg-COPYING.LGPLv2.1"
cp "$source_root/zlib/LICENSE" "$package_root/licenses/zlib-LICENSE"
cp "$source_root/freetype/LICENSE.TXT" "$package_root/licenses/FreeType-LICENSE.TXT"
cp "$source_root/freetype/docs/FTL.TXT" "$package_root/licenses/FreeType-FTL.TXT"
cp "$source_root/fribidi/COPYING" "$package_root/licenses/FriBidi-COPYING"
cp "$source_root/harfbuzz/COPYING" "$package_root/licenses/HarfBuzz-COPYING"
cp "$source_root/libass/COPYING" "$package_root/licenses/libass-COPYING"
cp "$source_root/spirv-cross/LICENSES/Apache-2.0.txt" "$package_root/licenses/SPIRV-Cross-Apache-2.0.txt"
cp "$source_root/spirv-cross/LICENSES/MIT.txt" "$package_root/licenses/SPIRV-Cross-MIT.txt"
cp "$source_root/libplacebo/LICENSE" "$package_root/licenses/libplacebo-LICENSE"
cp "$source_root/libplacebo/3rdparty/jinja/LICENSE.txt" "$package_root/licenses/libplacebo-build-Jinja-LICENSE.txt"
cp "$source_root/libplacebo/3rdparty/markupsafe/LICENSE.txt" "$package_root/licenses/libplacebo-build-MarkupSafe-LICENSE.txt"
for package_license in \
  /ucrt64/share/licenses/shaderc/LICENSE \
  /ucrt64/share/licenses/glslang/LICENSE.txt \
  /ucrt64/share/licenses/spirv-tools/LICENSE; do
  test -f "$package_license" || { echo "Missing shader toolchain license: $package_license" >&2; exit 1; }
done
cp /ucrt64/share/licenses/shaderc/LICENSE "$package_root/licenses/shaderc-LICENSE"
cp /ucrt64/share/licenses/glslang/LICENSE.txt "$package_root/licenses/glslang-LICENSE.txt"
cp /ucrt64/share/licenses/spirv-tools/LICENSE "$package_root/licenses/SPIRV-Tools-LICENSE"

zip_directory() {
  local source="$1" destination="$2" source_win destination_win
  rm -f "$destination"
  source_win="$(cygpath -w "$source")"
  destination_win="$(cygpath -w "$destination")"
  powershell.exe -NoLogo -NoProfile -NonInteractive -Command \
    "Compress-Archive -CompressionLevel Optimal -Path '$source_win\\*' -DestinationPath '$destination_win' -Force"
}
zip_directory "$package_root/source" "$artifact_root/dependency-corresponding-source.zip"
zip_directory "$package_root/licenses" "$artifact_root/dependency-licenses.zip"

printf '%s\n' "$ffmpeg_commit" > "$artifact_root/ffmpeg-commit.txt"
printf '%s\n' "$prefix" > "$artifact_root/prefix-path.txt"
echo "Pinned LGPL libmpv dependency prefix created at: $prefix"
