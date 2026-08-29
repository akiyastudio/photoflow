#!/usr/bin/env bash
set -euo pipefail

# Builds the complete, pinned LGPL-compatible dependency prefix used by
# build-libmpv-lgpl-windows.sh. Run from an MSYS2 UCRT64 shell.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
work_root="${PHOTOFLOW_MPV_DEPENDENCY_ROOT:-$repo_root/.cache/media-runtime-build/mpv-dependencies}"
jobs="${NUMBER_OF_PROCESSORS:-4}"

work_root="$(realpath -m "$work_root")"
case "$work_root" in
  "$repo_root"/.cache/media-runtime-build/*) ;;
  *) echo "Refusing to clean unsafe dependency directory: $work_root" >&2; exit 1 ;;
esac

prefix="$work_root/prefix"
source_root="$work_root/src"
build_root="$work_root/build"
artifact_root="$work_root/artifacts"
package_root="$work_root/package"
bootstrap_source_archive="${PHOTOFLOW_MPV_BOOTSTRAP_SOURCE_ARCHIVE:-}"
bootstrap_license_archive="${PHOTOFLOW_MPV_BOOTSTRAP_LICENSE_ARCHIVE:-}"
bootstrap_manifest="${PHOTOFLOW_MPV_BOOTSTRAP_MANIFEST:-}"
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
command -v patch >/dev/null 2>&1 || {
  echo 'Missing build tool: patch (install the MSYS2 patch package)' >&2
  exit 1
}

bootstrap_dependency_root=""
if [[ -n "$bootstrap_source_archive" ]]; then
  bootstrap_source_archive="$(realpath "$bootstrap_source_archive")"
  bootstrap_license_archive="$(realpath "${bootstrap_license_archive:?Set PHOTOFLOW_MPV_BOOTSTRAP_LICENSE_ARCHIVE with the bootstrap source archive}")"
  bootstrap_manifest="$(realpath "${bootstrap_manifest:?Set PHOTOFLOW_MPV_BOOTSTRAP_MANIFEST with the bootstrap archives}")"
  test -f "$bootstrap_source_archive" || { echo "Missing bootstrap source archive: $bootstrap_source_archive" >&2; exit 1; }
  test -f "$bootstrap_license_archive" || { echo "Missing bootstrap license archive: $bootstrap_license_archive" >&2; exit 1; }
  test -f "$bootstrap_manifest" || { echo "Missing bootstrap manifest: $bootstrap_manifest" >&2; exit 1; }
  node "$repo_root/media-runtime/verify-bootstrap-archives.cjs" \
    "$bootstrap_manifest" "$bootstrap_source_archive" "$bootstrap_license_archive"
  bootstrap_root="$work_root/bootstrap"
  mkdir -p "$bootstrap_root/source" "$bootstrap_root/licenses" "$bootstrap_root/dependencies"
  bsdtar -xf "$bootstrap_source_archive" -C "$bootstrap_root/source"
  bsdtar -xf "$bootstrap_license_archive" -C "$bootstrap_root/licenses"
  test -f "$bootstrap_root/source/dependency-corresponding-source.zip" || { echo 'Bootstrap archive is missing dependency corresponding source' >&2; exit 1; }
  test -f "$bootstrap_root/licenses/dependency-licenses.zip" || { echo 'Bootstrap archive is missing dependency licenses' >&2; exit 1; }
  bsdtar -xf "$bootstrap_root/source/dependency-corresponding-source.zip" -C "$bootstrap_root/dependencies"
  bootstrap_dependency_root="$bootstrap_root/dependencies"
fi

clone_locked() {
  local name="$1" repo="$2" commit="$3" destination="$4"
  if [[ -n "$bootstrap_dependency_root" ]]; then
    local archive
    archive="$(find "$bootstrap_dependency_root" -maxdepth 1 -type f -iname "*-$commit.zip" -print -quit)"
    test -n "$archive" || { echo "Bootstrap archive is missing locked source: $name $commit" >&2; exit 1; }
    mkdir -p "$destination"
    bsdtar -xf "$archive" -C "$destination"
    return
  fi
  if ! git -C "$destination" rev-parse --git-dir >/dev/null 2>&1; then
    rm -rf "$destination"
    git init "$destination"
    git -C "$destination" remote add origin "$repo"
  else
    git -C "$destination" remote set-url origin "$repo"
  fi
  if ! git -C "$destination" cat-file -e "$commit^{commit}" >/dev/null 2>&1; then
    local attempt
    for attempt in 1 2 3; do
      if git -C "$destination" fetch --depth 1 origin "$commit"; then
        break
      fi
      if [[ "$attempt" == 3 ]]; then
        echo "Failed to fetch locked $name commit after $attempt attempts" >&2
        return 1
      fi
      sleep 2
    done
  fi
  git -C "$destination" checkout --force --detach "$commit"
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
if [[ -n "$bootstrap_dependency_root" ]]; then
  for submodule in jinja markupsafe; do
    submodule_archive="$(find "$bootstrap_dependency_root/libplacebo-build-submodules" -maxdepth 1 -type f -iname "*$submodule-*.zip" -print -quit)"
    test -n "$submodule_archive" || { echo "Bootstrap archive is missing libplacebo submodule: $submodule" >&2; exit 1; }
    mkdir -p "$source_root/libplacebo/3rdparty/$submodule"
    bsdtar -xf "$submodule_archive" -C "$source_root/libplacebo/3rdparty/$submodule"
  done
fi

# libass and FreeType probe optional libraries with required:false, which
# bypasses their disabled feature options and makes output depend on whichever
# libraries happen to be installed on the build host. Keep those probes out of
# the fixed Windows runtime dependency graph.
apply_locked_patch() {
  local directory="$1" patch_file="$2"
  if patch --forward --dry-run --silent --batch -d "$directory" -p1 -i "$patch_file" >/dev/null 2>&1; then
    patch --forward --silent --batch -d "$directory" -p1 -i "$patch_file"
  elif ! patch --reverse --dry-run --silent --batch -d "$directory" -p1 -i "$patch_file" >/dev/null 2>&1; then
    echo "Locked source patch does not apply cleanly: $patch_file" >&2
    exit 1
  fi
}
apply_locked_patch "$source_root/libass" "$repo_root/media-runtime/patches/libass-disable-iconv.patch"
apply_locked_patch "$source_root/freetype" "$repo_root/media-runtime/patches/freetype-disable-bzip2.patch"
apply_locked_patch "$source_root/libplacebo" "$repo_root/media-runtime/patches/libplacebo-static-winpthread.patch"

export PKG_CONFIG_PATH="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
export CFLAGS="-O2"
export CXXFLAGS="-O2"
export LDFLAGS="-static-libgcc -static-libstdc++ -Wl,-Bstatic -lwinpthread -Wl,-Bdynamic"

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
  -Dauto_features=disabled -Dzlib=system -Dbzip2=disabled -Dpng=disabled \
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

static_stdcxx="$(c++ -print-file-name=libstdc++.a)"
static_winpthread="$(c++ -print-file-name=libwinpthread.a)"
test -f "$static_stdcxx" || { echo "Missing static libstdc++ archive: $static_stdcxx" >&2; exit 1; }
test -f "$static_winpthread" || { echo "Missing static winpthread archive: $static_winpthread" >&2; exit 1; }
cmake -S "$source_root/spirv-cross" -B "$build_root/spirv-cross" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_SHARED_LINKER_FLAGS="-Wl,--as-needed -static-libgcc -static-libstdc++" \
  "-DCMAKE_CXX_STANDARD_LIBRARIES=$static_stdcxx $static_winpthread -lkernel32 -luser32 -lgdi32 -lwinspool -lshell32 -lole32 -loleaut32 -luuid -lcomdlg32 -ladvapi32" \
  -DSPIRV_CROSS_CLI=OFF -DSPIRV_CROSS_ENABLE_TESTS=OFF \
  -DSPIRV_CROSS_STATIC=OFF -DSPIRV_CROSS_SHARED=ON
cmake --build "$build_root/spirv-cross" --parallel "$jobs"
cmake --install "$build_root/spirv-cross"

LDFLAGS="-Wl,--as-needed -static $LDFLAGS" meson setup "$build_root/libplacebo" "$source_root/libplacebo" \
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
if [[ -n "$bootstrap_dependency_root" ]]; then
  cp "$bootstrap_root/source/dependency-corresponding-source.zip" "$artifact_root/dependency-corresponding-source.zip"
  cp "$bootstrap_root/licenses/dependency-licenses.zip" "$artifact_root/dependency-licenses.zip"
else
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
fi

cp "$repo_root/media-runtime.lock.json" "$package_root/source/build-materials/media-runtime.lock.json"
cp "$repo_root/media-runtime/build-libmpv-dependencies-windows.sh" "$package_root/source/build-materials/"
cp "$repo_root/media-runtime/patches/libass-disable-iconv.patch" "$package_root/source/build-materials/"
cp "$repo_root/media-runtime/patches/freetype-disable-bzip2.patch" "$package_root/source/build-materials/"
cp "$repo_root/media-runtime/patches/libplacebo-static-winpthread.patch" "$package_root/source/build-materials/"
cp "$work_root/ffmpeg-configure-flags.txt" "$work_root/ffmpeg-config.mak" "$package_root/source/build-materials/"
if command -v pacman >/dev/null 2>&1; then
  pacman -Q > "$package_root/source/build-materials/msys2-packages.txt"
fi
if [[ -z "$bootstrap_dependency_root" ]]; then
  for directory in ffmpeg zlib "${dependency_dirs[@]}"; do
    git -C "$source_root/$directory" diff --binary > "$package_root/source/build-materials/$directory-changes.diff"
  done
fi

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
if [[ -z "$bootstrap_dependency_root" ]]; then
  zip_directory "$package_root/source" "$artifact_root/dependency-corresponding-source.zip"
  zip_directory "$package_root/licenses" "$artifact_root/dependency-licenses.zip"
fi

printf '%s\n' "$ffmpeg_commit" > "$artifact_root/ffmpeg-commit.txt"
printf '%s\n' "$prefix" > "$artifact_root/prefix-path.txt"
echo "Pinned LGPL libmpv dependency prefix created at: $prefix"
