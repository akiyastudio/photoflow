# PhotoFlow libmpv playback backend

这是照片流“高级视频解码”的独立可选原生后端工程。它提供 `advanced-video-decoder.exe`、libmpv 运行库、签名/完整性材料和许可证材料，通过 `media-playback-backend-v1` 与 Host 通信。组件只注册自身 HWND；PhotoFlow core 验证进程所有权并负责嵌入、DPI、定位和裁切。

播放器界面、裁剪、截图、键盘/鼠标语义、字幕默认选择和播放设置全部属于照片流主程序。运行时通过 `media.playbackBackend@v1` 声明无 UI 的解码/渲染能力，只上报原始输入、轨道和播放状态并执行通用控制命令。安装此运行时不安装任何 renderer bundle；缺少、卸载、启动失败或崩溃时，主程序可切换到尚未尝试的 Chromium 后端，只有所有后端均失败时才提示修复组件或使用系统播放器。

组件默认使用稳定的 `gpu` 视频输出、D3D11、`hwdec=auto-safe` 和预读缓存。硬件不支持相机的 H.265 10-bit 4:2:2 时，libmpv 自身会回退到 CPU 解码。这里不启用 `gpu-next`，因为它在嵌入 Electron 子窗口时可能触发原生 D3D11 访问冲突。

## 从源码一键构建发布包

在 MSYS2 UCRT64 环境中，在本工程目录运行：

```bash
npm run build:release
```

该命令会完成以下工作：

1. 按 `media-runtime.lock.json` 的完整提交哈希构建 zlib、FreeType、FriBidi、HarfBuzz、libass、SPIRV-Cross、libplacebo 和 LGPL FFmpeg。
2. 构建固定版本的 mpv 0.41.0，并强制使用 `-Dgpl=false`、WASAPI、D3D11 和硬件解码。
3. 生成并校验 `runtime-manifest.json`、全部 DLL 的 SHA-256、对应源码包和许可证包。
4. 编译 `advanced-video-decoder.exe` 并生成可安装组件 ZIP。整个流程只读取本工程内的 lock、策略、源码和脚本。

输出文件：

```text
dist/PhotoFlow-video-playback-mpv-26.8.28.3-win32-x64.zip
```

## 仅使用已有运行时打包

若已经拥有由上述流程生成的运行时，可以跳过依赖编译；`npm run build` 只验证并打包已有运行时，不会声称重新构建 libmpv：

```powershell
npm run build -- --mpv-root C:\path\to\libmpv-runtime
```

运行时目录必须包含版本 2 的 `runtime-manifest.json`、清单内声明的所有 DLL、`libmpv-lgpl-corresponding-source.zip` 和 `libmpv-lgpl-licenses.zip`。打包器会复核许可证、完整提交哈希、mpv/FFmpeg 构建参数和所有文件哈希；未知来源的 DLL 或手工编写的占位清单不会生成发布 ZIP。
