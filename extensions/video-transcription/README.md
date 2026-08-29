# PhotoFlow 视频转文字组件

这是一个 Component Host contractVersion 2、Host API 7 的官方沙箱组件。用户从 PhotoFlow 文件页面选择一个或多个视频、文件夹或混合条目，再通过工具栏或右键菜单中唯一的“视频转文字”入口执行；组件不会弹出文件选择器，也不会取得绝对路径。所选文件夹由服务通过分页视频目录递归解析，项目视频在实际运行时由 `project.media.variants.v7` 重新授权。成功结果持久化后会安全回收完整视频副本，只保留 SRT、字幕段和发布 receipt。

## 架构

- `service.cjs`：由 PhotoFlow 监管的 Node JSONL 服务，负责 Host API、任务编排、取消、checkpoint、逐文件失败隔离和发布。
- `engine.py`：每个 operation 启动一个持久私有 JSONL 算法进程，同一批次复用一次 faster-whisper 模型加载并逐文件失败隔离；中文结果经 OpenCC `tw2sp` 转简体并写 UTF-8 BOM SRT。
- `storage.sqlite3`：由 `component.storage.v7` 分配，保存 operation、逐文件状态和字幕片段；UI 搜索使用 SQLite，FTS5 可用时同时维护全文索引。
- `component.settings.v7`：保存 language、model、device、compute type、beam size、VAD、简体转换和 CPU 回退开关。

从唯一的 `project.contextAction` 打开时，页面会按 Host 绑定的 `scopeRelativePath` 与完整 `selectedRelativePaths` 自动创建一次 operation，并立即调用 `transcript.operation.run.v1`。工具栏打开的是历史页，空选择不会启动任务；页面只允许重新处理当前 Host 选择。任务只有在所有可处理文件都结束后才进入终态：全部成功为 `completed`，部分成功为 `partial_failure`，全部失败为 `failed`，用户取消为 `cancelled`。失败文件和已完成文件都可在 UI 检查，取消或失败任务可从持久化 checkpoint 恢复。

## 开发运行时发现

依次尝试：Host 注入的开发运行时、`PHOTOFLOW_TRANSCRIBER_EXECUTABLE`、包内 `_internal/transcriber.exe`、`PHOTOFLOW_TRANSCRIPTION_PYTHON`、`C:\dev\app3\.venv\Scripts\python.exe`、系统 Python。插件只复用了 app3 的算法思想与可选开发环境，不导入或修改 app3 CLI、`subtitle_index.db`、`.venv` 或模型。

可选环境变量：

- `PHOTOFLOW_TRANSCRIPTION_PYTHON`：包含 faster-whisper 与 OpenCC 的 Python。
- `PHOTOFLOW_TRANSCRIBER_EXECUTABLE`：已打包的 JSONL `transcriber.exe`。
- `PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX`：上述可执行文件的 JSON 参数数组（主要用于测试/开发）。
- `PHOTOFLOW_WHISPER_MODEL_ROOT`：模型根目录；其下应有与设置中 model 同名的目录。

CUDA 模型加载失败且启用回退时，算法会明确报告诊断并重试 CPU `int8`。运行时或依赖缺失会在工具页和设置页给出不含路径的诊断。

## 输出约束

项目媒体默认发布到媒体旁的同名 `.srt`，并可通过 `dialogs.v7/openOutput` 打开已发布输出。`dialogs.v7` 不用于选择输入。若同名项目文件已存在但并非本组件拥有，Host 的冲突保护可能拒绝覆盖；原文件不会被破坏。

## 构建和测试

```powershell
npm test --prefix extensions/video-transcription
npm run package --prefix extensions/video-transcription
npm run build:components -- --only video-transcription
```

普通 Windows x64 打包生成 `PhotoFlow-video-transcription-26.8.29.1-win32-x64.zip` thin package，并保留清晰的缺失运行时诊断。正式离线包可指定已审计的 PyInstaller 产物及模型：

```powershell
node extensions/video-transcription/scripts/package-component.cjs --runtime C:\release\transcriber.exe --model-root C:\release\models
```

模型资源不会默认复制，避免把 large-v3 意外提交或打进测试包。

## 已知限制

- 单次选择最多解析 2,000 个视频；图片、独立音频和无关文件会被忽略，超大目录应拆批处理。
- faster-whisper 在一个长静音段中可能较久不产生 segment；组件页面发出的直接取消会立即终止算法进程，但 Host 后台任务面板的取消要到下一次进度上报或文件边界才会被观察到。
- SRT 作为文本通过 `project.output.v7` 发布；超出 Host 单次受控输出上限的异常大字幕会被拒绝并保留在组件私有存储。
- 页面刷新不会重复创建同一选择的任务；再次从文件页执行或点击“重新处理当前选择”会创建新的任务。
