# PhotoFlow Component Host API V2 规范

本文档是新组件的规范性说明。运行时清单校验器位于 `electron/component-host-contract.cjs`，机器可读约束位于 `electron/contracts/schemas/`，公开类型位于 `component-sdk/index.d.ts`。

## 版本协商与弃用

PhotoFlow 当前支持 Host API 2–7，并在组件声明的闭区间兼容范围中选择最高版本。`componentHost.contractVersion:2` 要求显式声明权限；`application.settingsPage` 从 Host API 3 开始可用，受控通知从 Host API 4 开始可用，项目只读扩展从 Host API 5 开始可用，项目写入扩展从 Host API 6 开始可用，安全 secrets、受控网络和新 contribution 从 Host API 7 开始可用。

RPC 方法、能力和事件都以 `.vN` 结尾。已发布语义不可修改；可以增加兼容字段，消费者必须忽略未知字段。破坏性变化使用新的方法/事件版本。弃用版本至少保留一个正常组件迁移窗口，并在移除前记录。`electron/compatibility/` 下的 V1 业务适配器已经弃用，不属于公开 API，也不再增加方法。

渲染桥接 `window.photoFlowComponent.contractVersion` 仍为 `1`；这是小型 preload ABI，不是协商后的 Host API。Host API 协商结果读取 `context.hostApiVersion`。

## 清单与权限

V2 必须声明合约版本、兼容范围、贡献项、服务协议/运行时/入口、版本化 RPC 白名单、Host 能力白名单和权限白名单；无事件时也要显式写空数组。能力需要匹配权限：

| 能力 | 权限 | 用途 |
| --- | --- | --- |
| `project.media.page.v7` | `project.media.read` | 有界递归媒体分页 |
| `project.media.variants.v7` | `project.media.read` | 显式解析缩略图、预览或原图 |
| `project.input.tokens.v7` | `project.input.read` | 将受限输入物化到私有存储 |
| `project.output.v7` | `project.output.write` | 暂存、登记/写入、校验、提交、回滚 |
| `version.create.v7` | `project.version.create` | 从已提交制品创建通用版本 |
| `component.storage.v7` | `component.storage` | 组件私有数据和 SQLite 位置 |
| `component.settings.v7` | `component.settings` | 与版本无关的私有 JSON 设置 |
| `tasks.v7` | `tasks` | 进度、检查点、取消与恢复握手 |
| `dialogs.v7` | `dialogs` | 宿主管理的确认和有界文件选择 |
| `component.events.v7` | `events` | 已声明的版本化组件事件 |
| `component.lifecycle.v7` | `component.lifecycle.read` | 协商版本、授权和生命周期状态 |
| `component.media.v7` | `component.media` | 私有存储下的媒体变体/打开/显示 |
| `project.progress.v7` | `project.progress` | 列出/创建进度节点并登记来源关系 |
| `notifications.v7` | `notifications` | 向主程序顶部 Toast 提交短暂纯文本状态 |
| `project.files.page.v7` / `project.files.search.v7` | `project.files.read` | 非媒体文件、目录和 sidecar 的有界分页/搜索 |
| `project.media.metadata.v7` | `project.media.read` | 白名单 EXIF、尺寸、色彩、相机/镜头与视频元数据 |
| `project.versions.page.v7` / `project.version.graph.v7` | `project.versions.read` | 有界版本分页与只读版本/进度来源图 |
| `project.media.ratings.v7` | `project.media.ratings.read` | 批量读取宿主实际支持的评分字段 |
| `project.media.ratings.write.v7` | `project.media.ratings.write` | 批量评分 CAS 写入；逐项明确成功或失败 |
| `project.version.update.v7` | `project.version.write` | 支持字段的原子版本 CAS 更新 |
| `project.version.delete.v7` | `project.version.delete` | 独立高风险权限下的版本 CAS 删除 |
| `project.progress.manage.v7` | `project.progress.manage` | 节点更新/取消登记与来源边变更 |
| `project.import.v7` | `project.import` | 一次性输入令牌的多文件事务导入 |
| `project.files.mutate.v7` | `project.files.write` | preflight/commit 的文件变更与收据 undo |
| `project.media.process.v7` | `project.media.process` | 视频时间轴/裁剪与 Office 图片提取 |
| `component.secrets.v7` | `component.secrets` | safeStorage 加密的组件隔离秘密引用 |
| `network.fetch.v7` | `network.fetch` | origin allowlist、DNS pinning 与秘密绑定的 HTTPS 请求 |

执行已声明的生命周期动作还需要 `component.lifecycle.manage`。代理对 `describe` 仍检查 `component.lifecycle.read`；生命周期服务在执行 `preflight`、`install`、`repair` 或 `uninstall` 前检查更强权限。

权限在解析清单时检查一次，每次能力调用时再次检查。组件 ID/版本、项目 ID/名称/状态和作用域来自绑定的宿主页面，载荷不能覆盖这些身份。

Host API 3 的 V2 清单可选声明 `application.settingsPage`，其 `id`、`label`、可选 `title`、包内 `entry` 和 `rpcMethods` 都经严格校验。设置页上下文的 `surface` 是 `application.settings`，没有项目身份；页面只能调用 contribution 列出且同时存在于 `service.rpcMethods` 的方法。服务在该 surface 下仅能使用已授权的组件设置、生命周期、确认对话框和 API4 通知；其他 Host 能力全部默认拒绝。

### 顶部短通知（Host API 4）

声明 `notifications.v7` 和 `notifications` 的组件必须设置 `minHostApiVersion >= 4`。renderer 优先 feature-detect `window.photoFlowComponent.notify`，只提交 `{tone,message,dedupeKey?}`；后端 service 仅在处理既有请求时使用同语义的 `notifications.v7` capability。renderer 不应为了通知绕到 service，service 也不能借此获得任意 renderer channel。`durationMs` 已从契约删除，出现该字段会作为未知字段被明确拒绝；组件不能控制通知生命周期。

宿主只接受 `info|success|warning|error`、raw 与 trim 后均不超过 360 字的非空纯文本，`dedupeKey` 为最多 80 字的 ASCII ID。生命周期完全由宿主按 tone 决定：`error` 常驻至手动关闭，`info`、`success`、`warning` 统一在 3500 ms 后自动消失；组件不能提交 `durationMs`。组件 preload 在复制到主进程前执行同一硬边界；未知字段、HTML、URL、路径、回调和命令均拒绝。发送方绑定到已通过完整性准入的组件 `webContents`；清单能力与权限在每次调用时复核。宿主按组件执行普通状态和 error 各自有界的 burst/10 秒速率限制、1.2 秒内容/键去重，并在 renderer 销毁或组件卸载/升级时清理状态。主窗口不可用或发送竞态失败时返回 retryable 的 `NOTIFICATION_HOST_UNAVAILABLE`，而不是创建 Electron 原生提示。

结果固定为 `apiVersion:2`：成功为 `{accepted:true,id}`，重复为 `{accepted:false,deduplicated:true,code:"NOTIFICATION_DEDUPLICATED"}`，失败包含 `{accepted:false,error:{code,message,retryable}}`。主进程在 React subscriber 完成 ready 握手前使用有界缓冲，reload 后重新握手并 flush；卸载/升级发送组件作用域 purge。事件经主 preload 再校验后进入有总量上限的现有 `useTopToastStack`，四种 tone 与宿主普通 Toast 共用图标、颜色、生命周期、去重/堆叠、关闭及单层 live-region 策略；error 始终保持到手动关闭，其余 tone 使用宿主统一自动消失时间。Toast 由宿主透明原生 overlay 窗口呈现，始终位于 project 与 settings 的组件 `WebContentsView` 之上，组件 View bounds 不会因 Toast 改变。overlay 空白区域鼠标穿透，卡片与按钮可交互。长任务继续使用 `tasks.v7`；需要用户决定继续使用 `dialogs.v7`。

## 能力合约

### 项目媒体

Host API 5 的项目只读扩展要求 `minHostApiVersion >= 5`。`project.files.page.v7` 只返回目录、非媒体普通文件与识别的 sidecar；`project.files.search.v7` 额外要求 1–160 字符查询。两者每页 1–200 项，单次快照最多检查 5,000 个目录项，搜索最多保留 500 个结果，游标 5 分钟过期并绑定组件、项目与 scope。返回值只有虚拟相对路径；符号链接、`.photoflow-*` 内部项、绝对路径与越界路径拒绝。

`project.media.metadata.v7` 只接受绑定 scope 内的媒体相对路径。宿主向 ExifTool 请求固定字段白名单，返回实际可得的尺寸、色彩空间/配置、相机、镜头、拍摄参数，以及视频编码、音频编码、时长、帧率和旋转；不可得字段为 `null`，绝不回显 `SourceFile`、目录或绝对路径。

`project.versions.page.v7` 使用单次有界只读 SQL 快照读取当前/父版本、状态、备注、final/current 和时间戳，每页最多 200 项、快照最多 5,000 个版本，并用 `truncated` 明示边界。它不会调用会同步或回填索引的 `media_get`。`project.version.graph.v7` 使用只读 `progress_snapshot` 返回版本父边和持久化进度来源边，不执行迁移、baseline 注册、repair 或位置同步，也不返回文件夹路径。普通进度节点必须有可验证的物理目录且 canonical 路径位于当前 scope；`includeMissing:true` 还允许 lexical 路径位于 scope、最近存在祖先 canonical 安全且真实标记 `folderMissing` 的节点。缺少可靠绝对路径、外链或越界节点始终排除，来源边仅在两端节点均可见时返回。宿主最多扫描 5,000 个进度记录，再公开其中最多 1,000 个可见节点；任一边界截断都会返回 `truncated:true`。`project.media.ratings.v7` 一次接受 1–100 个媒体引用，返回评分及文件修订时间；当前宿主没有统一标签/选择状态存储，因此 `supported.labels`、`supported.selectionState` 为 `false` 且对应字段为 `null`，不会伪造数据。

这些 P0 能力当前仅覆盖项目物理目录，不解析宿主管理的外链虚拟路径。组件必须 feature-detect 并保留旧媒体分页方案处理外链，不能把外链物理路径提交给新能力。

`project.media.page.v7` 接受 `pageSize`（1–200）、不透明 `cursor` 和 `kinds`（`image`、`raw`、`video`）。游标 5 分钟过期，绑定单一组件/项目，不得解码或持久化。每页最多检查 1,000 个条目，不跟随符号链接。宿主管理的外部文件/目录以虚拟相对路径参与；未管理外部路径继续拒绝。

`project.media.variants.v7` 接受 `{photoId, versionId}` 或 `{relativePath}`，以及 `thumbnail`、`preview`、`original` 的子集。缩略图是 320 像素派生图，绝不会用普通原图 URL 替代；预览为 1,600 像素派生图；原图明确标记 `derived:false`。`variants:[]` 只返回元数据，不创建 URL 授权、缩略图请求或输入令牌。包含 `original` 的请求还会得到 10 分钟有效、一次性使用的输入令牌。

`project.input.tokens.v7 {action:"materialize",token}` 消耗令牌并把输入复制到组件私有存储。令牌绑定组件、工作区和项目，使用或过期后失效。渲染层不能提交原始路径。

### 私有存储与设置

`component.storage.v7` 返回工作区应用数据下的组件专属位置，而不是项目内容写入授权。组件拥有自己的结构和迁移；宿主不检查组件业务表。清单声明 `component.storage.previous.v1` adoption grant 后，宿主事务式复制同 ID 的上一代数据根/数据库，保留来源供回滚，并返回来源与摘要收据，供组件安全重写自有路径。跨域引用使用稳定项目/媒体/版本 ID。

大型首次采用异步执行。校验复制进行时，`component.storage.v7` 返回带判别字段 `adoption.state:"pending"` 的结果，只包含采用身份和 `startedAt`；不会返回 `dataPath` 或 `databasePath`，也不能推断。组件可以显示只读状态，但所有存储读写和变更必须关闭。以 500–1000 ms 有界退避轮询。返回 `state:"committed"` 后，结果包含组件路径和完整同组件收据：采用标志、旧引用、数据库摘要、复制文件数与字节数。宿主保留 V1 来源，并使用采用日志在崩溃后丢弃或继续未完成树。

`component.media.v7` 只接受私有存储下相对文件和 `variants`、`open` 或 `reveal` 动作。变体语义与项目媒体相同。结果只包含 URL 和不透明媒体引用，不返回调用方提交的绝对路径。删除与失效仍由组件数据库负责。

`component.settings.v7` 支持 `get`、`replace` 和浅层 `merge`。设置和检查点是最大 256 KiB 的 JSON 对象。更新原子执行并返回单调递增修订号。组件必须容忍保留的未知键，并自行迁移旧结构。

### 输出事务与版本

### Host API 7：secrets、网络与宿主入口

`component.secrets.v7` 在 project 与 application settings surface 可用。`put`、`list`、`delete` 都严格校验字段；list 永不返回秘密值。put 幂等收据独立于当前同名 record，旧 key 重放只返回原结果，不会回滚后续更新；用于比较原请求的收据内容同样由 `safeStorage` 加密，不持久化可离线枚举的秘密摘要，且密文计入总容量。读取时严格白名单验证 componentId、record/receipt/deletion 形状、公开结果字段、时间戳、metadata、base64 密文与 ref/name 唯一性；任一异常隔离整文件。普通 view 关闭不清除锁，显式清数据在同 component 锁队列后执行并阻止竞态写回。秘密仅以 Electron `safeStorage` 密文原子保存，加密不可用时 fail closed。

`network.fetch.v7` 要求 canonical `origin` 与 URL origin 完全相同并属于 manifest `networkOrigins`。headers/secrets 必须为 plain object，mode、timeout、body 类型严格校验，GET/HEAD 禁止 body，base64 必须为 canonical 编码。单一总 deadline 与卸载 controller 从 secret 解析前开始，覆盖秘密锁/磁盘等待、DNS、连接、redirect 与响应；每跳过滤非 global 地址，并把验证地址直接交给 `agent:false` TLS transport lookup，原 hostname 用于 SNI、Host 和证书。跨 origin redirect 剥离 authorization/cookie/proxy header；301/302/303 转 GET 并清 body。secret 只能通过 `secretBindings` 注入固定 header。卸载经 capability barrier abort 活动请求，计数只在 finally 释放；普通 view 关闭不修改网络并发状态。

Host API 7 contribution 为 `component.sidePanel`、`media.contextAction`、`project.contextAction`、`project.importProvider`、`project.exportProvider`、`application.command`。每项声明 `id`、`label`、`pageId` 和独立 `rpcMethods` allowlist；pageId 必须引用包内 fullPage，RPC 必须属于 service。项目入口绑定触发时的 scope 与 selection；跨目录媒体选择以共同祖先为 scope。application command 使用无项目 application context，且只有实际含命令的全局 Dock 注册 `Ctrl/Cmd+Shift+P`。宿主 UI 分别在项目工具栏/可调侧面板、媒体与项目右键菜单、导入/导出菜单及可搜索命令入口发现并打开这些 contribution。所有 surface 使用同一 sandbox preload，禁止导航、新窗口和 Node 集成；组件卸载、升级或项目关闭会关闭对应 view。

Host API 6 的七项写能力必须设置 `minHostApiVersion >= 6`，且各自声明上表中的最小权限。评分批量限制为 1–100，采用逐项语义；只支持图片/RAW 的 `rating`，视频、标签和选择状态写入拒绝。checked CAS 与宿主旧评分 outbox 共用同一 per-file 队列；ExifTool 成功后的索引指纹刷新是非致命维护步骤，不会把已发生的评分副作用报告成失败。版本更新/删除、进度节点与边变更均使用 `expectedUpdatedAt` CAS；删除权限独立。progress 的项目/scope 路径会在数据库事务内再次以 Windows case-insensitive path-key 语义验证，所有图端点必须在当前物理 scope 内、不得是 external link，并继续复用数据库角色和循环约束。

`project.import.v7` 先保留同 component/workspace/project/scope 的一次性 input token，再执行 stage→validate→commit；reservation 只暂停清理，不延长原 10 分钟授权，释放时恢复原到期并立即删除已过期 token。同幂等键并发调用共享一个 active owner，取消、冲突或失败会释放令牌并回滚已发布且摘要未变的文件。任何 import/file/process 恢复都重新执行 `lstat`、拒绝链接、验证 `realpath` 位于当前 canonical scope，并复核文件 SHA-256 或目录 identity/owner marker；目标被其他主体替换时既不认领成功，也不移动替换内容。

`project.files.mutate.v7` 的短时 plan 绑定身份与摘要，commit 前再次复核；rename/move/mkdir/trash 默认拒绝覆盖、链接、Windows 保留名/尾点/尾空格、宿主保护根目录、进度目录和越界路径。每个 move 在副作用前写入 from/to intent 及文件 SHA-256 或目录 identity；插件目录 move 限制为同卷，从而可在 move 后、applied 前崩溃时验证并补记 applied。mkdir 使用 prepared/applied 日志。trash 使用 file-operations 域的原子替换命令收据：`executing` 状态若发现任一源已消失即为不可判定结果，返回人工恢复所需的 `outcomeUnknown`，永不重复 OS trash，也不伪装为 committed。preflight 的 `undoCapability` 对 trash 为 `requires-precise-recycle`；commit 只有在全部结果均为 `preciseRestore:true`、`permanent:false` 且有 PIDL 时才返回 `undoAvailable:true`。否则仍明确报告已提交，但 `undoAvailable:false`、`undo:[]`，后续 undo 请求拒绝。

undo 本身同样使用逐项 intent/applied 日志。move undo 复核原 mutation 的摘要/目录 identity；mkdir undo 只移除仍属于原 mkdir 且为空的目录；recycle restore 在 originalPath 不存在时先 probe PIDL，probe 不确定或项目目标身份不匹配会返回人工恢复错误，绝不重复 restore。

`project.media.process.v7` 当前完整处理动作是 `video.timelineFrames`、`video.trim` 和 `office.extractImages`；长处理还支持用相同幂等键及 `processAction` 调用 `status`/`cancel`。当前调用采用 await 语义：处理调用在宿主长请求租约内等待完成，同时后台任务提供进度、checkpoint 和协作式取消；发布前持久化确定性 target、owner 与摘要。Office 即使没有图片也先在组件私有 stage 创建空目录和 operation owner marker，再原子 move 到输出位置，消除 createDirectory 与 marker 之间的恢复空窗；同名目录被其他主体抢占时拒绝。receipt 恢复成功时会把对应后台 task 终态纠正为 `completed`，使 status 与收据一致。组件卸载会取消该组件仍活动的 import/process，in-flight 幂等锁会保留至实际 settle，阻止同 ID 重装后并发重放。renderer 没有这些 IPC 通道，只能由受监管服务调用领域能力。

`project.output.v7` 动作：

- `stage`：创建私有 stage，并把路径返回给受监管后端。
- `write`：登记 stage 下已有 `sourceName`、复制输入令牌，或接收最大 8 MiB 内联 base64；绑定 `outputRelativePath` 并返回 artifact ID。
- `validate`：拒绝空、链接、越界、缺失或超限 stage。单 stage 最多 2,000 文件、2 GiB。
- `commit`：要求 ID 形状幂等键，默认拒绝覆盖，原子发布绑定项目下文件；多文件失败会回滚已创建文件，并返回 commit/artifact ID。相同键重试返回原结果。
- `rollback`：只递归删除组件私有 stage，可安全清理放弃任务。
- `adopt`：仅供一次性迁移。声明 `project.output.existing.v1` adoption grant 后，可提交项目相对输出或组件旧记录中的绝对来源。宿主只接受规范路径位于绑定项目根内、非符号链接的普通文件，并返回不回显绝对路径的项目相对收据。这不是通用文件系统 API。
- `materializeOwned`：校验已提交输出收据和当前摘要，将制品复制到组件私有存储，使组件迁移结构时无需保留项目路径。
- `delete`：仅在旧 commit/artifact ID 和期望摘要仍匹配时删除当前输出，并写入幂等删除收据。

stage 状态不只存在内存中。宿主在可写载荷子目录外原子持久化 stage 元数据和登记文件，绑定组件/工作区/项目，并对每个非终态动作执行不可变 `createdAt + 24h` 过期。过期只删除该已验证 stage 目录。

发布前，`commit` 写入包含稳定 commit ID、目标相对路径、artifact ID、大小、SHA-256 和逐文件发布状态的 `prepared` 收据。每次原子发布后写日志；只有全部输出存在且摘要匹配才转为 `committed`。重启恢复只复用匹配字节。冲突时回滚仍匹配的宿主输出，并保留用户已改动文件。无法最终写收据时回滚完整多文件发布并移除无效日志。

受控替换要求 `write` 同时提供 `replace:true`、`previousCommitId`、`previousArtifactId` 和 `expectedDigest`。旧收据必须拥有同一目标且当前字节仍匹配。替换备份留在会过期的 stage 中，直到新多文件收据提交。旧输出采用受清单控制、同组件/项目作用域、项目相对且校验摘要，不包含组件业务规则。

项目内容目标必须是相对路径；绝对路径和 `..` 无效。组件不能提交到绑定项目之外，也不能使用其他组件/项目的 stage 或 commit。

`version.create.v7` 使用已提交制品及照片/父版本 ID。重启后直接从已提交收据解析 `commitId`，不要求重放 `commit`。版本 ID 由绑定作用域和幂等键确定性生成；数据库调用前持久化 `prepared` 版本收据。重试先在真实照片版本中查找稳定 ID，即使宿主崩溃或最终收据写入失败也不会重复创建版本。

`project.progress.v7` 支持 `list`、`create` 和 `relate`，返回稳定 progress/edge ID，不返回目录路径。创建接收项目虚拟 `relativePath`、`image`/`video` 类型、版本键、结构父 ID、可选 `sourceProgressIds` 和 `sourceMetadata`。元数据是白名单扁平对象：`category`、`role`、`displayName` 为非空、无控制字符、最多 128 字符；`parentCapability` 为 `structural`、`workflow-input` 或 `none`。省略或 `{}` 默认 `{ category:'progress', parentCapability:'structural' }`。宿主始终覆盖 `componentId`，创建前拒绝未知/嵌套字段。列表返回持久化非空元数据；旧空记录仍为 `null`。版本仓库检查图角色和循环。

### 任务、取消与恢复

`tasks.v7` 动作为 `start`、`report`、`status`、`cancel`、`resume`、`complete`、`fail`。`operationId` 稳定并绑定组件/项目，进度为 0–100，报告可保存 JSON 检查点。取消为协作式：返回 `cancelled:true` 后服务停止工作、保持项目内容不变，并回滚 stage 或只保留私有可恢复数据。`resume` 使用提供或返回的检查点启动/重新绑定。重复终态转换无害。

不要让同步服务请求长时间保持打开。普通超时 60 秒。已审查的 V1 长方法保留旧版 4 小时兼容超时；该例外不适用于新 API。

### 安全对话框、事件与生命周期

`dialogs.v7` 支持 `confirm`、`openFiles`、`openOutput`、`revealOutput`。文件选择返回受限令牌，而不是调用方选择的输出路径。输出动作只接受收据和当前摘要仍匹配的已提交 `{commitId, artifactId}`。扩展过滤规范化后最多 64 项；最多返回 2,000 个选择。

`component.events.v7` 只发送 `service.events` 声明的版本化主题和最大 256 KiB JSON 对象。投递为尽力而为、至少一次；消费者处理器必须幂等。事件不携带文件路径，也不修改宿主状态。

`component.lifecycle.v7 {action:"describe"}` 返回已安装组件版本、协商 Host API、权限、声明事件/动作和状态。拥有 `component.lifecycle.manage` 时，`preflight`、`install`、`repair`、`uninstall` 只会在验证安装版本、根目录、符号链接和 SHA-256 后执行清单中对应的包内 PowerShell 入口。载荷命令、参数和路径都会拒绝。已验证脚本只得到固定 `PHOTOFLOW_COMPONENT_LIFECYCLE_ACTION`、组件 ID/版本和小型 OS 环境白名单。页面创建/销毁和项目关闭仍由宿主管理。

## 协议、限制与错误

UI RPC 与服务 JSONL 帧都是 JSON 对象，上限 2 MiB。方法/事件名有界且版本化。未知方法、严格清单边界字段、发送方、能力、权限、stage、token 和事件主题全部默认拒绝。服务 stdout 每行一个 JSON 帧，日志写 stderr。`component-host-api-v2.schema.json` 为每个能力提供按方法区分的请求/结果分支；`component-service-protocol-v1.schema.json` 定义 JSONL 帧。

稳定错误码：

- `COMPONENT_HOST_INVALID_REQUEST`、`COMPONENT_HOST_PERMISSION_DENIED`、`COMPONENT_HOST_NOT_FOUND`
- `COMPONENT_HOST_TOKEN_EXPIRED`、`COMPONENT_HOST_TOKEN_SCOPE`、`COMPONENT_HOST_LIMIT_EXCEEDED`
- `COMPONENT_HOST_VARIANT_UNAVAILABLE`、`COMPONENT_HOST_CONFLICT`、`COMPONENT_HOST_CANCELLED`
- `COMPONENT_HOST_TIMEOUT`、`COMPONENT_HOST_SERVICE_EXITED`、`COMPONENT_HOST_INTERNAL`

错误包含可读消息，可能包含 `retryable`。只在明确标记可重试或文档说明操作幂等时重试。结果不明确后，绝不能换一个新幂等键重试变更。

## 数据归属、安全与兼容

宿主拥有项目、媒体索引/变体、版本、文件安全、任务中心、组件生命周期和权限账本。组件拥有私有存储、设置结构、算法、UI 状态和业务实体。只有宿主发布项目内容；双方都不能更新对方数据库。

V1 组件数据和协议继续保留。已弃用适配器只翻译已审查旧路由，并可能访问旧组件自有存储；V2 代码不能导入它们。删除组件源码目录不能导致宿主、SDK、schema、示例或通用测试无法构建。新代码必须通过架构断言：通用组件宿主文件中不得出现组件业务表或字段名。
