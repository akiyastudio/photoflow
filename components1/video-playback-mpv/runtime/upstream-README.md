# 高级视频解码

这是照片流的可选视频播放组件。它在独立进程中运行 libmpv，通过 Win32 子窗口把视频画面嵌入照片流，并通过 JSON Lines 与 Electron 主进程交换播放状态和控制命令。

组件默认使用 `gpu-next`、D3D11、`hwdec=auto-safe` 和预读缓存。硬件不支持相机的 H.265 10-bit 4:2:2 时，libmpv 会回退到 CPU 解码；组件启动或播放失败时，照片流会回退到 Chromium `<video>` 预览。

## 一键构建发布包

在 Windows x64 的 MSYS2 UCRT64 环境中安装仓库工作流列出的工具，然后在仓库根目录运行：

```bash
npm run build:advanced-video-release
```

该命令会完成以下工作：

1. 按 `media-runtime.lock.json` 的完整提交哈希构建 zlib、FreeType、FriBidi、HarfBuzz、libass、SPIRV-Cross、libplacebo 和 LGPL FFmpeg。
2. 构建固定版本的 mpv 0.41.0，并强制使用 `-Dgpl=false`、WASAPI、D3D11 和硬件解码。
3. 生成并校验 `runtime-manifest.json`、全部 DLL 的 SHA-256、对应源码包和许可证包。
4. 编译 `advanced-video-decoder.exe` 并生成可安装组件 ZIP。

输出文件：

```text
artifacts/installers/PhotoFlow-video-playback-mpv-26.8.16.1-win32-x64.zip
```

## 仅使用已有运行时打包

若已经拥有由上述流程生成的运行时，可以跳过依赖编译：

```powershell
npm run build:advanced-video-decoder -- --mpv-root C:\path\to\libmpv-runtime
```

运行时目录必须包含版本 2 的 `runtime-manifest.json`、清单内声明的所有 DLL、`libmpv-lgpl-corresponding-source.zip` 和 `libmpv-lgpl-licenses.zip`。打包器会复核许可证、完整提交哈希、mpv/FFmpeg 构建参数和所有文件哈希；未知来源的 DLL 或手工编写的占位清单不会生成发布 ZIP。
