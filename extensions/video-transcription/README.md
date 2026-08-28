# PhotoFlow 视频语音识别 / 字幕组件

这是一个 Component Host contractVersion 2、Host API 7 的沙箱组件。renderer 不接触绝对路径：外部文件和文件夹由 `dialogs.v7` 选择并签发短期输入令牌，服务会在选择返回后立即以有界并发消费并物化全部令牌；项目媒体在实际运行时由 `project.media.variants.v7` 重新授权。成功结果持久化后会安全回收完整媒体副本，只保留 SRT、字幕段和发布 receipt。

## 架构

- `service.cjs`：由 PhotoFlow 监管的 Node JSONL 服务，负责 Host API、任务编排、取消、checkpoint、逐文件失败隔离和发布。
- `engine.py`：每个 operation 启动一个持久私有 JSONL 算法进程，同一批次复用一次 faster-whisper 模型加载并逐文件失败隔离；中文结果经 OpenCC `tw2sp` 转简体并写 UTF-8 BOM SRT。
- `storage.sqlite3`：由 `component.storage.v7` 分配，保存 operation、逐文件状态和字幕片段；UI 搜索使用 SQLite，FTS5 可用时同时维护全文索引。
- `component.settings.v7`：保存 language、model、device、compute type、beam size、VAD、简体转换和 CPU 回退开关。

启动 RPC 只完成安全选择/登记并返回 `operationId`；`transcript.operation.run.v1` 是被 `tasks.v7` 监管的长 RPC。任务只有在所有可处理文件都结束后才进入终态：全部成功为 `completed`，部分成功为 `partial_failure`，全部失败为 `failed`，用户取消为 `cancelled`。失败文件和已完成文件都可在 UI 检查，取消或失败任务可从持久化 checkpoint 恢复。

## 开发运行时发现

依次尝试：Host 注入的开发运行时、`PHOTOFLOW_TRANSCRIBER_EXECUTABLE`、包内 `_internal/transcriber.exe`、`PHOTOFLOW_TRANSCRIPTION_PYTHON`、`C:\dev\app3\.venv\Scripts\python.exe`、系统 Python。插件只复用了 app3 的算法思想与可选开发环境，不导入或修改 app3 CLI、`subtitle_index.db`、`.venv` 或模型。

可选环境变量：

- `PHOTOFLOW_TRANSCRIPTION_PYTHON`：包含 faster-whisper 与 OpenCC 的 Python。
- `PHOTOFLOW_TRANSCRIBER_EXECUTABLE`：已打包的 JSONL `transcriber.exe`。
- `PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX`：上述可执行文件的 JSON 参数数组（主要用于测试/开发）。
- `PHOTOFLOW_WHISPER_MODEL_ROOT`：模型根目录；其下应有与设置中 model 同名的目录。

CUDA 模型加载失败且启用回退时，算法会明确报告诊断并重试 CPU `int8`。运行时或依赖缺失会在工具页和设置页给出不含路径的诊断。

## 输出约束

项目媒体默认发布到媒体旁的同名 `.srt`。外部输入不能绕过沙箱回写原目录，因此发布到当前项目的 `视频字幕/<operationId>/...` 受控输出，UI 会明确说明，并可通过 `dialogs.v7/openOutput` 打开。若同名项目文件已存在但并非本组件拥有，Host 的冲突保护可能拒绝覆盖；原文件不会被破坏。

## 构建和测试

```powershell
npm test --prefix extensions/video-transcription
npm run package --prefix extensions/video-transcription
npm run build:components -- --only video-transcription
```

普通打包生成可安装的 thin package，并保留清晰的缺失运行时诊断。正式离线包可指定已审计的 PyInstaller 产物及模型：

```powershell
node extensions/video-transcription/scripts/package-component.cjs --runtime C:\release\transcriber.exe --model-root C:\release\models
```

模型资源不会默认复制，避免把 large-v3 意外提交或打进测试包。

## 已知限制

- `dialogs.v7/openDirectory` 最多签发 Host 规定数量的输入令牌；超大目录应拆批处理。
- faster-whisper 在一个长静音段中可能较久不产生 segment；组件页面发出的直接取消会立即终止算法进程，但 Host 后台任务面板的取消要到下一次进度上报或文件边界才会被观察到。
- SRT 作为文本通过 `project.output.v7` 发布；超出 Host 单次受控输出上限的异常大字幕会被拒绝并保留在组件私有存储。
- 失败或取消的外部输入会暂留组件私有 `inputs/` 以支持恢复；成功重试后立即回收，放弃恢复时可通过卸载组件/清除该组件数据统一删除。项目媒体失败副本会立即删除，并在恢复时重新向 Host 授权。
