<div align="center">
  <img src="public/app-logo.svg" alt="照片流图标" width="88" />
  <h1>照片流 PhotoFlow</h1>
  <p>面向摄影师的本地项目管理与素材工作流工具</p>
  <p>
    <a href="https://github.com/akiyastudio/photoflow/releases/latest">下载最新版</a>
    · <a href="https://github.com/akiyastudio/photoflow/issues">反馈问题</a>
    · <a href="docs/ARCHITECTURE.md">架构说明</a>
  </p>
</div>

照片流把拍摄项目、SD 卡导入、素材浏览、选片、后期版本和交付归档放进同一个桌面工作区。它主要服务于摄影工作中重复但容易出错的文件操作：整理 RAW、JPG 和视频，跟踪多轮后期文件，快速找回客户选中的素材，以及把多人修图结果安全地合回原图。

数据默认在本机处理，不需要把项目素材上传到云端。

> [!WARNING]
> 项目仍处于个人开发和持续迭代阶段，尚未经过大规模设备与素材兼容性测试。首次使用前请备份重要数据，并先用副本验证自己的工作流。文件导入默认可能移动源文件；如需保留源文件，请先在 **设置 → 导入 → 导入后保留原始文件** 中开启复制模式。

## 主要特性

### 摄影项目工作区

- 按 **策划中、待拍摄、后期中、已归档** 管理项目状态。
- 以标签页同时打开多个项目，在网格或列表中浏览文件。
- 为普通图片、RAW 和视频生成缩略图，提供快速预览、全屏查看与技术元数据。
- 支持新建、导入、复制、移动、重命名和删除文件；长任务显示进度并可取消。
- Windows 下可识别 Photoshop，并将选中的图片直接交给 Photoshop 打开。
- 使用本地 SQLite 记录项目、文件身份、后期版本和可恢复操作，不把数据库写进项目目录。

### SD 卡导入与素材整理

- 识别多个存储卡盘符，可分别指定为工作素材或花絮素材后批量导入。
- 自动把素材整理到 `raw`、`jpg`、`mov` 等项目目录。
- 可为大型视频生成 H.264 预览文件，减少工作区播放压力。
- 可把超过 4 GB 的视频无损分段，兼容 FAT32 或有单文件限制的存储服务。
- 文件复制先写入临时文件，再原子发布到目标位置；跨盘移动完成校验后才处理源文件。

### 选片、后期版本与交付

- 根据客户给出的文件名，从指定图片和视频目录中批量找回素材。
- 图片和视频分别输出到 `图片选片`、`视频选片`，避免混在原始素材中。
- 可新建、导入或标记“图片后期 / 视频后期”进度目录。
- 对比两轮后期文件并建立版本关系，记录备注、作者、当前版本与最终版状态。
- 汇总并导出项目中已经标记的最终版本。

### 多人修脸

安装 `team-retouch` 组件后，可以把一张高分辨率合照拆成适合多人协作的小图：

1. AI 检测画面中的人物并规划裁切范围。
2. 为每个人填写名称和接收人，导出修图小图。
3. 收到手机或其他软件修好的图片后批量回传。
4. 对齐、匹配颜色、处理重叠区域，并自动合回原始尺寸。

该流程同时保留人工确认环节；人物范围或合并质量不确定时会标记为“需要确认”。

### 日常工具

- **PNG 转 JPG**：批量转换并设置 JPG 输出质量。
- **视频切割**：按 4 GB 无损分段过长的 MOV / MP4 素材。
- **调研整理**：整理图片和视频、图片去重，并通过转场检测提取代表帧。
- **Office 图片提取**：从 DOCX、PPTX 和 XLSX 中提取内嵌图片。
- **角色生日**：可选的首页生日提醒，也可以完全关闭。

## 安装

目前主要发布和验证的平台是 **Windows x64**。

1. 前往 [Releases](https://github.com/akiyastudio/photoflow/releases/latest) 下载最新版 `照片流 Setup <版本>.exe`。
2. 如需可选功能，同时下载对应的 `PhotoFlow-<组件>-<版本>-win32-x64.zip`，并把 ZIP 放在安装程序旁边。
3. 运行安装程序。安装页会自动识别旁边的组件包，可按需选择。
4. 第一次启动时选择工作文件夹。若选择磁盘根目录，照片流会在该磁盘下创建 `照片流` 文件夹。

代码中保留了 macOS 构建配置，但当前主要工作流、精确回收站恢复和多人修脸组件以 Windows 为主要验证环境，macOS 暂不保证同等功能完整度。

### 安装或更新可选组件

当前提供三个独立组件：

| 组件 | 功能 | 支持平台 |
| --- | --- | --- |
| `team-retouch` | 人物检测、裁切、对齐与合回 | Windows x64 |
| `research-tools` | 视频分镜、图片去重与调研整理 | Windows / macOS |
| `office-media-extractor` | 提取 Word、PowerPoint、Excel 内嵌图片 | Windows / macOS |

推荐在安装主程序时，把组件 ZIP 放在安装程序旁边一并安装。也可以解压后把完整组件目录放到：

```text
<照片流安装目录>\components\team-retouch
<照片流安装目录>\components\research-tools
<照片流安装目录>\components\office-media-extractor
```

然后进入 **设置 → 组件管理 → 刷新状态**。更详细的组件打包和目录约定见 [components/README.md](components/README.md)。

## 快速上手

### 1. 设置工作目录与导入方式

首次启动后选择一个专门存放客户项目的工作目录。正式导入前建议先检查：

- **设置 → 导入 → 导入后保留原始文件**：开启后使用复制导入；关闭时可能移动源文件。
- **超过 4 GB 的视频自动分割**：需要兼容 FAT32 或云盘限制时开启。
- **生成视频预览**：大型视频较多、希望提升软件内预览速度时开启。
- **设置 → 存储与转换**：调整缩略图缓存位置、容量和 JPG 输出质量。

### 2. 创建并推进项目

点击左侧 **新建项目**，填写日期、项目名称或两者。新项目默认进入“策划中”。在项目右键菜单中可以：

- 切换到待拍摄、后期中或已归档；
- 从 SD 卡导入工作素材；
- 导入花絮；
- 根据文件名选片；
- 重命名或移入系统回收站。

### 3. 导入拍摄素材

在首页的 **从 SD 卡导入** 中选择一个或多个盘符，为每张卡指定“工作文件”或“花絮”，然后开始导入。也可以在项目工作区中直接导入普通文件、图片进度、视频进度或花絮。

导入期间请不要拔出存储卡。任务可以取消，但应等待界面显示已经取消或完成后再断开设备。

### 4. 选片

在项目右键菜单选择 **从文件名选片**：

1. 设置图片来源目录（通常为 `raw`）和视频来源目录（通常为 `mov`）。
2. 粘贴客户给出的文件名或编号。
3. 开始选片，结果分别进入 `图片选片` 和 `视频选片`。

### 5. 管理后期版本

在项目空白处的菜单中新建或导入图片/视频进度。开启版本跟踪后，可把新一轮后期目录与上一轮进行匹配，随后在单个素材的 **版本管理** 中查看历史、对比版本、填写说明并标记最终版。

### 6. 归档交付

确认成片后标记最终版，在项目顶部查看最终版汇总并导出。项目完成后把状态移到“已归档”，工作目录中的实际文件仍保持普通文件夹结构，可继续使用资源管理器或其他软件访问。

## 数据与文件安全

- 所有核心项目数据均在本机处理；项目素材不会因使用本软件自动上传到网络。
- 普通复制、移动和大型视频导入使用临时文件与完成校验，避免把不完整文件伪装成最终文件。
- Windows 删除操作优先进入系统回收站，并记录轻量恢复信息；数据库不会保存一份完整的被删媒体副本。
- 撤销操作会检查文件身份，避免同路径出现新文件后误删或误覆盖。
- 缩略图和版本预览保存在应用数据/缓存目录，不污染客户项目目录。

这些保护不能替代独立备份。网络盘、移动硬盘断连、磁盘空间不足和第三方文件同步仍可能造成操作失败。

## 从源码运行

### 环境

- Windows 10/11 x64（当前主要开发平台）
- 较新的 Node.js LTS 与 npm
- Python 3.12 环境（推荐使用项目根目录下的 `.venv`）
- Windows .NET Framework C# 编译器，用于构建 Shell 缩略图与回收站辅助程序

### 开发启动

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
npm run electron:dev
```

完整媒体与组件构建还需要相应的 FFmpeg、OpenCV、ONNX Runtime / DirectML 依赖。多人修脸开发环境可通过以下命令准备：

```powershell
npm run setup:team-retouch
```

### 构建

```powershell
# 仅构建 React 渲染层
npm run build

# 构建主程序、Python worker、可选组件和 Windows 安装包
npm run electron:build
```

构建结果输出到 `release/`。可选组件会生成独立 ZIP，不会强制塞进主安装包。

### 检查与测试

```powershell
npm run lint
npm run test:architecture
npm run test:file-transfer
npm run test:filesystem-safety
npm run test:thumbnail-pipeline
npm run test:components
```

仓库还包含选片、数据维护、Office 图片提取、调研整理和多人修脸等专项测试，具体命令见 `package.json`。

## 技术架构

照片流是一个模块化的本地桌面单体应用：

```text
React + TypeScript
        ↓ preload API
Electron IPC 模块
        ↓
业务服务 / 文件服务 / 媒体服务
        ↓
SQLite worker · Python 工具 · FFmpeg · ONNX · Windows C# 辅助程序
```

- `src/`：React 界面、项目工作区、设置与工具页面。
- `electron/modules/`：按领域划分的 IPC 入口。
- `electron/services/`：文件、媒体、缩略图、版本和后台任务工作流。
- `electron/repositories/`：SQLite 访问边界。
- `python/`：导入、选片、转换、媒体处理和数据库 worker。
- `components/`：可独立分发的高级功能组件。

更详细的模块边界和依赖规则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，文件操作风险与恢复策略见 [docs/FILESYSTEM_AUDIT.md](docs/FILESYSTEM_AUDIT.md)。

## 反馈

遇到问题时，请在 [GitHub Issues](https://github.com/akiyastudio/photoflow/issues) 中说明系统版本、照片流版本、操作步骤和错误提示。请勿上传包含客户隐私的原片；如需提供日志，请先检查并移除个人路径、文件名等敏感信息。

也可以通过邮件联系：`akiyastudio@qq.com`。
