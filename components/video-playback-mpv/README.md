# 高级视频解码

这是照片流的可选视频播放组件。它把 libmpv 放在独立进程中运行，使用
Win32 子窗口把视频画面嵌入照片流，并通过 JSON Lines 与 Electron 主进程
交换播放状态和控制命令。

组件默认启用 `gpu-next`、`d3d11`、`hwdec=auto-safe`、预读缓存和保留首帧。
硬件不支持相机的 H.265 10-bit 4:2:2 时，libmpv 会回退到 CPU 解码；组件进程
启动或播放失败时，PhotoFlow 会自动回退到原有 Chromium `<video>` 预览。

## 构建

先在 MSYS2 环境运行 `scripts/media-runtime/build-libmpv-lgpl-windows.sh`。
构建使用固定 mpv 0.41.0、`-Dgpl=false -Dlibmpv=true`，并要求传入一个已审计的
LGPL FFmpeg/libass/libplacebo 依赖前缀、依赖对应源码包和许可证包。脚本会拒绝
链接启用了 GPL、nonfree、x264、x265、xvid、Avisynth 或 rubberband 的 FFmpeg。

把生成目录作为 Windows x64 libmpv 运行目录，其中必须包含 DLL、
`runtime-manifest.json`、对应源码包和许可证包，然后运行：

```powershell
npm run build:advanced-video-decoder -- --mpv-root C:\path\to\libmpv
```

输出是独立 ZIP：

```text
release\PhotoFlow-video-playback-mpv-26.7.30.1-win32-x64.zip
```

此命令不会修改或打包照片流主程序。组件构建会强制复核 LGPL 声明、mpv/FFmpeg
构建参数、所有 DLL 哈希以及源码和许可证归档哈希；校验不通过时不会生成 ZIP。
