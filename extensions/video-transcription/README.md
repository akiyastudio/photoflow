# PhotoFlow 视频转文字组件

这是一个 Component Host contractVersion 2、Host API 的官方沙箱组件。用户从 PhotoFlow 文件页面选择一个或多个视频、文件夹或混合条目，再通过原有工具栏小图标或文件右键“视频工具”子菜单中的唯一“视频转文字”入口执行；组件不会弹出文件选择器，也不会取得项目绝对路径。所选文件夹由服务通过分页视频目录递归解析，项目视频在实际运行时由 `project.media.variants` 重新授权。每个成功结果会立即保存为源视频同目录、同名的 UTF-8 BOM `.srt`，随后安全回收完整视频副本。

## 架构

- 插件源码目录只包含 manifest/包元数据、Node 服务、纯函数核心、Python 算法入口、无框架 UI、测试/打包脚本、图标、文档和许可说明。
- `service.cjs`：由 PhotoFlow 监管的 Node JSONL 服务，负责 Host API、内存任务编排、取消、逐文件失败隔离，以及 SRT 的直接提交、遍历和受控读取。
- `engine.py`：每个 operation 启动一个持久私有 JSONL 算法进程，同一批次复用一次 faster-whisper 模型加载并逐文件失败隔离；中文结果经 OpenCC `tw2sp` 转简体并写 UTF-8 BOM SRT。
- 组件不创建用户数据库。任务状态仅存在于当前服务进程内；所有持久化文字均以项目目录中的 `.srt` 为准，目录、单文件浏览、“浏览全部”和搜索都会重新遍历并解析 SRT。
- `component.settings`：保存 language、model、device、compute type、beam size、VAD、简体转换和 CPU 回退开关。

Beam、VAD、简体转换、设备、计算类型、CPU 回退、语言与模型选择、模型安装状态和运行时诊断都位于同一个沙箱 `application.settingsPage`。页面复用 PhotoFlow 公共设置样式，并通过有界 debounce 和串行 RPC 自动保存，不再拼接 Host 表单与组件子页面。

从 `project.contextAction` 或携带选择的原工具栏 `project` surface 打开时，页面通过只读 `transcript.selection.preview.v1` 递归解析 Host 绑定的 `selectedRelativePaths`，并在左侧用目录树列出将处理的视频；预览不创建 operation/Host 任务、不物化媒体，也不会自动识别。用户必须点击“开始识别”，页面才会创建后台任务。任务只有在所有可处理文件都结束后才进入终态：全部成功为 `completed`，部分成功为 `partial_failure`，全部失败为 `failed`，用户取消为 `cancelled`。当前进程内的取消或失败任务仍可恢复；应用重启后不恢复任务记录，只保留已经落盘的 SRT。

字幕搜索位于工作区右侧。搜索和“浏览全部”都会直接遍历当前项目的所有 `.srt`，解析后再使用有界游标返回。搜索结果点击会切换到对应 SRT 并高亮精确字幕段。

## 开发运行时发现

Git 跟踪的源码和默认 thin ZIP 不包含 Python 环境、transcriber 可执行文件或模型。开发环境完全位于组件目录：`.venv` 安装自己的 Python 依赖，`models/<model-id>` 保存本地模型，两者均被 Git 和默认发布包排除。

运行时依次尝试：Host 注入的开发运行时、`PHOTOFLOW_TRANSCRIBER_EXECUTABLE`、正式自包含包内 `_internal/transcriber.exe`、`PHOTOFLOW_TRANSCRIPTION_PYTHON`、插件私有 `.venv`、系统 Python。正式自包含包把算法放在 `_internal/transcriber.exe`，模型放在 `models/<model-id>`。

可选环境变量：

- `PHOTOFLOW_TRANSCRIPTION_PYTHON`：包含 faster-whisper 与 OpenCC 的 Python。
- `PHOTOFLOW_TRANSCRIBER_EXECUTABLE`：已打包的 JSONL `transcriber.exe`。
- `PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX`：上述可执行文件的 JSON 参数数组（主要用于测试/开发）。

设置页显示完整模型根目录并提供“打开”按钮，仅列出受控 allowlist 中且已安装的模型。安装时手动将完整的 faster-whisper CTranslate2 目录放入 `models/<model-id>`，目录必须包含 `config.json`、`model.bin` 和 `tokenizer.json`。组件不接受模型路径或仓库 ID，不在运行时隐式下载；缺失、不完整或越界链接都会返回可诊断错误。模型切换仅影响切换后新建的任务；已建任务保留其设置快照。

CUDA 模型加载失败且启用回退时，算法会明确报告诊断并重试 CPU `int8`。运行时或依赖缺失会在工具页和设置页给出不含路径的诊断。

## 输出约束

识别完成即提交到媒体旁的同名 `.srt`，无需再次“发布”。若同名 SRT 已存在，组件会先通过 Host 的受控所有权机制读取当前摘要，再进行原子替换；中途失败不会破坏原字幕。字幕可通过 `dialogs/openOutput` 打开，`dialogs` 不用于选择输入。

## 构建和测试

```powershell
npm test --prefix extensions/video-transcription
npm run package --prefix extensions/video-transcription
npm run build:components -- --only video-transcription
```

开发组件不再通过 CMD/BAT 包装器启动。`npm run setup --prefix extensions/video-transcription` 会创建组件私有、被 Git 忽略的 `.venv`，并把 `requirements.txt` 依赖真正安装在该环境内。设置脚本会检查 `pyvenv.cfg`、依赖 `__file__` 和 `sys.path`；若现有环境由另一个 venv 创建或引用外部 site-packages，就重建该插件私有环境。Host 直接 spawn `.venv/Scripts/python.exe`。

普通 Windows x64 打包生成 `PhotoFlow-video-transcription-26.8.29.10-win32-x64.zip`。发布流程先用组件私有 Python 环境构建 `_internal/transcriber.exe`，其中包含 Python、faster-whisper、CTranslate2、PyAV/FFmpeg、OpenCC、ONNX Runtime 和 tokenizer 依赖，再生成组件 ZIP：

```powershell
npm run package --prefix extensions/video-transcription
```

发布包始终包含自包含算法运行时，最终用户无需安装 Python 或算法依赖。模型始终排除，避免把大模型意外提交或打进发布包；用户通过设置页给出的模型根目录单独放置模型。

## 已知限制

- 单次选择最多解析 2,000 个视频；图片、独立音频和无关文件会被忽略，超大目录应拆批处理。
- 后台任务取消由独立的 200ms 状态观察器处理，不依赖 faster-whisper 产出新 segment；取消会终止当前算法子进程并回滚尚未提交的 SRT 暂存区。
- `project.files.page` 单次扫描最多检查 Host 允许的项目条目数；特别大的项目可能显示截断结果。
- 只有用户在页面点击“开始识别”或“重新识别当前选择”才会创建新任务；页面初始化、刷新、激活和 context change 不会启动识别。
