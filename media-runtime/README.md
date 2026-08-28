# 照片流媒体运行时

安装包不再从 `imageio-ffmpeg` 提取未知构建。Windows 安装包只接受本目录策略校验通过的固定版本产物。

## FFmpeg

桌面转码运行库固定启用静态 `libx264` 与 `libx265`，并使用固定版本的 `nv-codec-headers` 编入 NVIDIA NVENC：H.264/H.265 都优先使用可用的 NVENC 或 Windows Media Foundation 硬件编码器，硬件失败时分别回退对应的软件编码器。NVENC 在运行时动态使用显卡驱动，不要求随应用分发 CUDA 工具包或额外 DLL。构建环境除基础编译工具外还需要 CMake 与 Ninja 来构建 x265。

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

libmpv 的固定版本、源码构建、许可证材料与发布说明由独立工程 `plugins/video-playback-backend/` 完整拥有；主程序媒体运行时目录只负责核心 FFmpeg 工具链。
