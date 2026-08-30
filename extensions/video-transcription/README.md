# PhotoFlow 视频转文字组件

这是一个 Component Host contractVersion 2、Host API 的官方沙箱组件。用户从 PhotoFlow 文件页面选择一个或多个视频、文件夹或混合条目，再通过原有工具栏小图标或文件右键“视频工具”子菜单中的唯一“视频转文字”入口执行；组件不会弹出文件选择器，也不会取得绝对路径。所选文件夹由服务通过分页视频目录递归解析，项目视频在实际运行时由 `project.media.variants` 重新授权。成功结果持久化后会安全回收完整视频副本，只保留 SRT、字幕段和发布 receipt。

## 架构

- 插件源码目录只包含 manifest/包元数据、Node 服务与 SQLite 核心、Python 算法入口、无框架 UI、测试/打包脚本、图标、文档和许可说明。
- `service.cjs`：由 PhotoFlow 监管的 Node JSONL 服务，负责 Host API、任务编排、取消、checkpoint、逐文件失败隔离、单文件发布和带独立 Host 任务租约的批量发布。
- `engine.py`：每个 operation 启动一个持久私有 JSONL 算法进程，同一批次复用一次 faster-whisper 模型加载并逐文件失败隔离；中文结果经 OpenCC `tw2sp` 转简体并写 UTF-8 BOM SRT。
- `storage.sqlite3`：由 `component.storage` 分配，保存 operation、逐文件状态和字幕片段；UI 搜索使用 SQLite，FTS5 可用时同时维护全文索引。
- `component.settings`：保存 language、model、device、compute type、beam size、VAD、简体转换和 CPU 回退开关。

Beam、VAD、简体转换、设备、计算类型、CPU 回退、语言与模型选择、模型安装状态和运行时诊断都位于同一个沙箱 `application.settingsPage`。页面复用 PhotoFlow 公共设置样式，并通过有界 debounce 和串行 RPC 自动保存，不再拼接 Host 表单与组件子页面。

从 `project.contextAction` 或携带选择的原工具栏 `project` surface 打开时，页面通过只读 `transcript.selection.preview.v1` 递归解析 Host 绑定的 `selectedRelativePaths`，并在左侧用目录树列出将处理的视频；预览不创建 operation/Host 任务、不物化媒体，也不会自动识别。即使项目已有历史任务，新 context 仍优先展示“当前选择”，用户可从目录下拉框主动切回历史。用户必须点击“开始识别”，页面才会按共同 `scopeRelativePath` 调用 `transcript.project.start.v1`，随后调用 `transcript.operation.run.v1`。启动 pending 期间按钮禁用，成功后可由用户再次显式点击“重新识别当前选择”。刷新、页面激活和 Host context change 都只更新界面；新 context 恢复为“开始识别”，空选择则拒绝启动。任务只有在所有可处理文件都结束后才进入终态：全部成功为 `completed`，部分成功为 `partial_failure`，全部失败为 `failed`，用户取消为 `cancelled`。失败文件和已完成文件都可在 UI 检查，取消或失败任务可从持久化 checkpoint 恢复。

字幕搜索位于工作区右侧，搜索和“浏览全部”均使用有界、不透明的稳定游标分页。搜索结果点击会切换到对应 operation/文件并高亮精确 segment；快速连续搜索、点击或翻页采用 latest-request-wins，旧响应不会覆盖当前视图。

## 开发运行时发现

Git 跟踪的源码和默认 thin ZIP 不包含 Python 环境、transcriber 可执行文件或模型。开发环境完全位于组件目录：`.venv` 安装自己的 Python 依赖，`models/<model-id>` 保存本地模型，两者均被 Git 和默认发布包排除。

运行时依次尝试：Host 注入的开发运行时、`PHOTOFLOW_TRANSCRIBER_EXECUTABLE`、正式自包含包内 `_internal/transcriber.exe`、`PHOTOFLOW_TRANSCRIPTION_PYTHON`、插件私有 `.venv`、系统 Python。正式自包含包把算法放在 `_internal/transcriber.exe`，模型放在 `models/<model-id>`。

可选环境变量：

- `PHOTOFLOW_TRANSCRIPTION_PYTHON`：包含 faster-whisper 与 OpenCC 的 Python。
- `PHOTOFLOW_TRANSCRIBER_EXECUTABLE`：已打包的 JSONL `transcriber.exe`。
- `PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX`：上述可执行文件的 JSON 参数数组（主要用于测试/开发）。

设置页仅列出受控 allowlist 中且已安装的模型。安装时手动将完整的 faster-whisper CTranslate2 目录放入 `models/<model-id>`，目录必须包含 `config.json`、`model.bin` 和 `tokenizer.json`。组件不接受路径或仓库 ID，不在运行时隐式下载；缺失、不完整或越界链接都会返回可诊断错误。模型切换仅影响切换后新建的任务；已建任务保留其设置快照。

CUDA 模型加载失败且启用回退时，算法会明确报告诊断并重试 CPU `int8`。运行时或依赖缺失会在工具页和设置页给出不含路径的诊断。

## 输出约束

项目媒体默认发布到媒体旁的同名 `.srt`，并可通过 `dialogs/openOutput` 打开已发布输出。`dialogs` 不用于选择输入。若同名项目文件已存在但并非本组件拥有，Host 的冲突保护可能拒绝覆盖；原文件不会被破坏。

## 构建和测试

```powershell
npm test --prefix extensions/video-transcription
npm run package --prefix extensions/video-transcription
npm run build:components -- --only video-transcription
```

开发组件不再通过 CMD/BAT 包装器启动。`npm run setup --prefix extensions/video-transcription` 会创建组件私有、被 Git 忽略的 `.venv`，并把 `requirements.txt` 依赖真正安装在该环境内。设置脚本会检查 `pyvenv.cfg`、依赖 `__file__` 和 `sys.path`；若现有环境由另一个 venv 创建或引用外部 site-packages，就重建该插件私有环境。Host 直接 spawn `.venv/Scripts/python.exe`。

普通 Windows x64 打包生成 `PhotoFlow-video-transcription-26.8.29.10-win32-x64.zip` thin package，并保留清晰的缺失运行时诊断。打包脚本支持 `--runtime` 和 `--model-root`；正式离线包可指定已审计的 PyInstaller 产物及模型：

```powershell
node extensions/video-transcription/scripts/package-component.cjs --runtime C:\release\transcriber.exe --model-root C:\release\models
```

不传这两个参数时生成 thin ZIP；它不会复制 Python env、transcriber 或任何模型，避免把 large-v3 意外提交或打进测试包。

## 已知限制

- 单次选择最多解析 2,000 个视频；图片、独立音频和无关文件会被忽略，超大目录应拆批处理。
- faster-whisper 在一个长静音段中可能较久不产生 segment；组件页面发出的直接取消会立即终止算法进程，但 Host 后台任务面板的取消要到下一次进度上报或文件边界才会被观察到。
- SRT 作为文本通过 `project.output` 发布；超出 Host 单次受控输出上限的异常大字幕会被拒绝并保留在组件私有存储。
- “发布全部 SRT”只处理当前项目当前 operation 的 completed 文件，逐文件失败隔离且最多返回 20 条脱敏失败摘要；页面关闭不撤销已经提交的 Host 发布任务，但 Host 取消可能在当前文件发布结束后的下一次状态检查才生效。
- 只有用户在页面点击“开始识别”或“重新识别当前选择”才会创建新任务；页面初始化、刷新、激活和 context change 不会启动识别。
