# 第三方发行证据核对表

核对日期：2026-09-01
适用版本：照片流 26.8.31 公测版
状态：`阻断未关闭；本文件不是法律意见或发行批准`

本文件区分基础 Windows 安装包与可选组件，并记录仓库中能直接验证的材料。最终结论必须基于实际拟发布归档、其 SBOM 和法律审核，不能从源码树存在某个文件推断发行义务已经履行。

## 1. 发行边界

### 基础 Windows 安装包

当前 `package.json` 的 Electron Builder `files` 只列出 `artifacts/web/**/*` 和 `electron/**/*`，另有 Python/原生辅助程序等 `extraResources`；没有把 `extensions/**` 整体列入基础安装包。该源码配置只能说明预期边界，发布前仍必须解包最终安装器并生成文件清单/SBOM，确认 FFmpeg、PairDETR、CUDA、模型或可选组件未被其他构建步骤带入。

### 可选组件

- `extensions/video-tools` 的 Windows x64 FFmpeg 运行时属于视频工具可选组件的供应材料，不应与基础安装包的清单混为一谈。
- `extensions/team-retouch` 记录了 PairDETR、SAM 2.1 的隔离 WSL CUDA 高级后端和离线包导入机制。仓库中的说明或导入代码不证明最终离线包已具备完整许可证、模型权利、依赖 SBOM、对应源码、CUDA/NVIDIA 再发行授权或各文件哈希。
- 在 PairDETR/CUDA 高风险可选包的上述证明和批准未完成前，不得把该离线包、VHDX、模型、CUDA 运行时或相关依赖纳入公开发行归档。本核对表不修改其代码，也不判断其最终许可证结论。

## 2. FFmpeg Windows x64 仓库实物核对

核对目录：`extensions/video-tools/media-runtime/vendor/windows-x64`

| 文件 | 仓库实际情况 | SHA-256 核对 |
| --- | --- | --- |
| `ffmpeg-runtime-windows-x64.zip` | 存在；20,785,848 字节 | 实际 `f6f3ede4231312fc621d78460fb3076646121b677e943c1333b75cdd415d0f29`；与 manifest 和 `SHA256SUMS.txt` 一致 |
| `ffmpeg-corresponding-source.zip` | 存在；73,576,348 字节；目录清单含 FFmpeg、x264、x265、zlib、zimg、freetype、fribidi、harfbuzz、libass、nv-codec-headers、libplacebo 及部分构建依赖源码/构建材料 | 实际 `e5da39f7fd47e2404e8804f9f59e54d3383f56b5ae9d0990aceffd98e4d15343`；与 manifest 和 `SHA256SUMS.txt` 一致 |
| `ffmpeg-licenses.zip` | 存在；72,622 字节；目录清单含 FFmpeg GPLv2、x264、x265、zlib、zimg、freetype、fribidi、harfbuzz、libass、nv-codec-headers、libplacebo、glslang、shaderc、SPIR-V Tools、Vulkan Headers 等许可证/通知 | 实际 `27ef49f233fd71a61d48fd5e3b23174d343eea8b0c2008245cb978c4b57fbb02`；与 manifest 和 `SHA256SUMS.txt` 一致 |
| `ffmpeg-runtime-manifest.json` | 存在；schemaVersion 4；声明 FFmpeg 7.1.5、commit、组件 commit/许可证、configure flags 和三个归档哈希 | 按仓库规定将文本行尾规范为 LF 后计算为 `aba4ef915294c705bfbf14f97306d702ea6e550d683098b04d599f5abb279440`；与 `SHA256SUMS.txt` 一致 |
| `SHA256SUMS.txt` | 存在；包含上述 4 项记录 | 读取时将 CRLF/CR 规范为 LF；Git checkout 的平台行尾差异不表示供应包损坏 |

以上仅是 2026-09-01 对当前 Git 工作树的只读核对，不是签名、时间戳或最终发行物证明。文件大小和实际哈希必须在最终候选归档上重新计算。

### Manifest 中观察到的构建身份

- FFmpeg：`7.1.5`，commit `3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587`，整体声明 `GPL-2.0-or-later`。
- 组件：x264、x265、zlib、zimg、freetype、fribidi、harfbuzz、libass、nv-codec-headers、libplacebo；manifest 逐项记录上游仓库、commit 和许可证标识。
- configure flags 包含 `--enable-gpl`、`--enable-libx264`、`--enable-libx265`、`--enable-libass`、`--enable-libzimg`、`--enable-zlib`、`--enable-ffnvcodec`、`--enable-nvenc`、`--enable-vulkan`、`--enable-libplacebo`、静态链接和禁用网络等。manifest 还包含构建机绝对前缀；最终公开材料应提供可复现但不依赖个人路径的规范化参数记录。
- 对应源码归档的 `build-materials/` 中观察到构建脚本、lock、补丁、configure/CMake 参数和依赖清单；仍需法律/发行负责人确认其覆盖实际链接进最终二进制的全部源码和修改。

## 3. 最终发行归档必须具备的材料

无论选择“同包提供对应源码”还是在许可证允许的范围内采用下载/书面要约，均由用户和律师对最终义务作选择。证据包至少包括：

| 证据 | 最低内容 | 文件 ID / SHA-256 / 结果 |
| --- | --- | --- |
| 最终二进制 SBOM | 安装包和每个可选组件实际包含的程序、库、模型、运行时、版本、供应者、许可证及文件哈希 | `[待填写]` |
| 许可证与版权通知 | 每个实际分发项的完整适用许可证全文、版权通知和要求展示的 NOTICE | `[待填写]` |
| 对应源码 | 与二进制精确对应的上游源码、子模块、生成脚本、补丁、构建文件和必要接口材料 | `[待填写]` |
| 构建身份 | configure/CMake/编译链接 flags、工具链和依赖版本、上游 commit/tag、补丁 hash | `[待填写]` |
| 完整性 | 安装包、组件包、运行时、许可证包、源码包和 manifest 的 SHA-256；如有签名则含证书/时间戳核验 | `[待填写]` |
| 获取方式 | 随发行物提供的路径，或稳定下载地址、可用性演练及保留期；如采用书面要约则保存经律师批准的要约文本、适用对象和有效期 | `[待填写]` |
| 最终归档复核 | 解包清单与 SBOM 一致；随机抽样许可证、源码和 hash；基础包与可选包边界正确 | `[待填写]` |

不得仅链接上游主页作为完整许可证或对应源码证据；不得用“可重新下载最新版”代替与发行二进制对应的版本、commit 和修改材料。

## 4. PairDETR / CUDA 高风险可选包门禁

在以下各项均有实际离线包证据和批准前，结果保持“不允许公开发行”：

- 离线包/VHDX 文件清单、逐文件或分层 SBOM、SHA-256 和构建来源；
- PairDETR、SAM 2.1、PyTorch、Python/Conda、Linux 用户空间、NVIDIA/CUDA/cuDNN 及所有传递依赖的准确版本和许可证；
- 模型/checkpoint 的来源、下载记录、权利或使用条款、再发行条件和文件哈希；
- 全部许可证、NOTICE、源码/修改、构建与安装脚本，以及适用的下载或书面要约；
- NVIDIA/CUDA 等专有材料是否允许所采用分发方式的律师书面结论；
- 与基础 Windows 包分离、明确选择安装、失败可回退且卸载边界清楚的最终包测试；
- 业务负责人和法务/律师对具体归档哈希的批准。

| 候选包 | 实际归档 SHA-256 | SBOM | 许可证/模型权利 | 对应源码/构建 | 律师批准 | 发行决定 |
| --- | --- | --- | --- | --- | --- | --- |
| PairDETR/SAM 2.1 WSL CUDA 离线包 | `[待填写]` | `[待填写]` | `[待填写]` | `[待填写]` | `[待填写]` | `不得公开发行` |

## 5. 批准记录

- 最终基础 Windows 安装包文件名 / SHA-256：`[待填写]`
- 最终可选 video-tools 包文件名 / SHA-256：`[待填写]`
- FFmpeg 文本规范化 hash 复核 commit / 证据：`[待填写]`
- SBOM、许可证、源码、下载/书面要约证据库 ID / SHA-256：`[待填写]`
- 技术复核人角色 / 日期：`[待填写]`
- 法务或律师复核人 / 日期：`[待填写]`
- 业务批准人 / 日期：`[待填写]`
