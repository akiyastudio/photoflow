# 照片流媒体运行时

安装包不再从 `imageio-ffmpeg` 提取未知构建。Windows 安装包只接受本目录策略校验通过的固定版本产物。

## FFmpeg

1. 在 GitHub Actions 运行 `Build audited media runtime`，或在 MSYS2 UCRT64 中运行 `bash scripts/media-runtime/build-ffmpeg-windows.sh`。
2. 下载完整工作流产物，并原样放入 `media-runtime/vendor/windows-x64/`。
3. 执行 `npm run verify:media-runtime`，再执行应用构建。

目录必须同时包含：

- `ffmpeg-runtime-windows-x64.zip`
- `ffmpeg-corresponding-source.zip`
- `ffmpeg-licenses.zip`
- `ffmpeg-runtime-manifest.json`
- `SHA256SUMS.txt`

`prepare-ffmpeg.cjs` 会验证许可证、必需/禁止构建参数及三个归档的 SHA-256，任何一项不合格都会中止安装包构建。

## libmpv

`scripts/media-runtime/build-libmpv-lgpl-windows.sh` 只构建 `-Dgpl=false -Dlibmpv=true` 的 libmpv，并在开始前拒绝链接启用了 GPL/nonfree/x264/x265 等选项的 FFmpeg。libass、libplacebo、FFmpeg 以及所有传递依赖也必须来自 LGPL 兼容前缀。运行前需要设置：

```bash
export LGPL_PREFIX=/path/to/lgpl-prefix
export LGPL_FFMPEG_COMMIT=完整的40位FFmpeg提交哈希
export LGPL_DEPENDENCY_SOURCE_ARCHIVE=/path/to/exact-dependency-sources.zip
export LGPL_DEPENDENCY_LICENSE_ARCHIVE=/path/to/dependency-licenses.zip
bash scripts/media-runtime/build-libmpv-lgpl-windows.sh
```

脚本会从实际 `ffmpeg.exe -buildconf` 读取配置，并把 FFmpeg 版本、完整提交哈希、依赖对应源码包和许可证包一起固化到 libmpv 清单中。

把最终 DLL、许可证、精确对应源码包和 `runtime-manifest.json` 放入 `components/video-playback-mpv/vendor/`。组件打包脚本会再次验证 LGPL 声明、构建参数和每个文件哈希。

`vendor/` 是本地或 CI 产物，不提交 Git；固定版本和构建脚本提交 Git。
