# 版本跟踪 V2 数据与行为契约

状态：**生产实现的唯一 V2 契约**  
适用范围：版本跟踪、版本树、选片、后台 compare/refresh 任务及其确认面板。

本文中的字段名、枚举和值是生产端、Electron、数据库和界面之间的统一语义。实现可以增加纯展示字段或数据库索引，但不得用文件夹名称、`versionKey` 格式或其他推断替代本文明确规定的字段。

## 1. 统一节点与关系模型

```ts
type VersionNodeRole = 'original' | 'progress' | 'selection' | 'artifact' | 'workflow' | 'broll'
type MediaKind = 'image' | 'video' | 'mixed'
type RelationKind = 'main' | 'auxiliary'
type TrackingState =
  | 'disabled'
  | 'pending_compare'
  | 'pending_confirm'
  | 'committing'
  | 'ready'
  | 'stale'
  | 'needs_repair'

interface TrackingPolicy {
  trackingEnabled: boolean
  renameFromParent: boolean
  copyMissingFromParent: boolean
}

interface VersionNode {
  id: string
  projectId: string
  role: VersionNodeRole
  mediaKind: MediaKind
  parentNodeId: string | null
  relationKind: RelationKind | null
  folderIdentity: string
  relativePath: string | null
  displayName: string
  versionKey: string | null
  trackingState: TrackingState
  trackingPolicy: TrackingPolicy
  deletedAt: string | null
}
```

`id` 是关系、任务结果和界面选择的唯一稳定标识。`folderIdentity` 是文件系统身份信息，用于识别移动/重命名后的同一物理文件夹；`relativePath` 是可变定位信息。任何关系都只能通过 `parentNodeId`/节点 ID 建立，不能依赖文件夹名、相对路径或版本编号。

节点角色：

- `original`：用户明确标记的原始素材节点，以及受限导入命令登记的 RAW、JPG、MOV；不使用版本号、结构父关系或跟踪。
- `progress`：主分支的版本进度节点。
- `selection`：选片产生的附属分支节点。
- `artifact`：配套/预览等由专用命令推导的产物节点；不得用来表示花絮。
- `workflow`：协作工作流节点。
- `broll`：用户明确标记的花絮节点，固定 `mediaKind='mixed'`，允许图片、RAW 与视频混合；不使用版本号、父关系、版本跟踪或任何版本图边。

边类型由子节点的 `relationKind` 表示：

- `main`：主分支边，版本树用实线绘制。
- `auxiliary`：附属分支边，版本树用虚线绘制。
- `original` 与 `broll` 的 `parentNodeId`/`relationKind` 必须为 `null`。
- `progress` 必须选择同项目、同媒体类型、仍存在的 `original` 或已合法连接的 `progress` 父节点，并持久化 `relationKind='main'`；不存在合法父节点时不得创建无父 V1。
- `selection` 必须有父节点并使用 `relationKind='auxiliary'`。`artifact`/`workflow` 的关系只由各自受限命令推导。

`relationKind` 是权威值。不得通过 `versionKey` 是否包含下划线、文件夹名或节点角色反推边类型。V2 写入时，`progress` 节点必须使用 `main`，`selection` 节点必须使用 `auxiliary`；读取旧数据时由迁移明确补齐，不能在运行时继续推断。`versionKey` 对 `original`/`artifact`/`workflow`/`broll` 仅可作为内部唯一键，界面不得把它显示成用户版本号。

## 2. 跟踪策略与界面状态

主分支节点必须持久化完整的 `trackingPolicy`，三个布尔值不能仅存在于面板临时状态：

- `trackingEnabled`：是否对该节点建立媒体跟踪。
- `renameFromParent`：提交时是否沿用父版本文件名。
- `copyMissingFromParent`：是否从父版本补齐当前版本缺失的媒体。

`renameFromParent` 和 `copyMissingFromParent` 只有在 `trackingEnabled=true` 时可为 `true`。只有带合法 `main` 父节点的 `progress` 可以启用跟踪；`original`、`broll`、`artifact`、`workflow` 与 `auxiliary` 节点必须持久化为三个值全为 `false`。界面必须隐藏或禁用并解释不可用能力，后端也必须拒绝这些角色开启任意一个选项。

内部状态到界面文案的唯一映射：

| 内部状态/节点 | 界面文案 | 语义 |
| --- | --- | --- |
| `disabled` | 未跟踪 | 未启用跟踪 |
| `pending_compare` | 跟踪处理中 | 正在建立或刷新比较会话 |
| `pending_confirm` | 跟踪处理中 | 比较完成，等待用户确认 |
| `committing` | 跟踪处理中 | 正在提交用户确认结果 |
| `ready` | 已跟踪 | 最近一次确认已成功提交 |
| `stale` | 待刷新 | 已提交结果已被文件变化影响 |
| `needs_repair` | 需要修复 | 异常/不完整状态，绝不能显示或计作“已跟踪” |
| `original` 节点 | 原始素材 | 节点角色文案，优先于跟踪状态文案 |
| `broll` 节点 | 花絮 | 独立用途分类，不属于版本链 |

状态转换的正常路径为：`disabled → pending_compare → pending_confirm → committing → ready`。刷新从 `stale → pending_compare` 开始。取消 compare 回到开始前状态；提交失败进入 `needs_repair` 或保留可恢复的 `pending_confirm`，由失败是否造成部分写入决定。

## 3. 任意项目内文件夹

任意项目内的真实文件夹都可以从统一“标记…”入口打开同一个标记面板，不要求名称符合版本规则。面板第一层仅提供“标记为：原始素材 / 进度 / 花絮”：

- 原始素材只显示媒体类型等必要字段，不显示版本号、父版本或跟踪设置。
- 进度显示媒体类型、父版本、版本号/分支和跟踪设置；没有合法父节点时显示“请先标记原始素材”并禁用提交。
- 花絮只显示分类说明，提交为 `broll/mixed`，不显示或提交父节点、版本号与跟踪字段。

三种用途之间切换必须构造新的分支草稿；从进度切到原始素材/花絮时，父节点、版本号、分支、跟踪和工作流输入字段必须从提交对象中消失，切回进度也不得恢复旧临时值。工具栏、右键菜单和待接入提示都只能打开该统一面板；右键“纳入版本树”高级子菜单只保留配套素材/预览产物等专用关系。

父版本自动选择只允许唯一明确的语义主线叶节点。存在多个原始来源、多个主线叶节点或其他歧义时，`parentProgressId` 与 `versionKey` 必须保持空值，由用户明确选择；不得依赖数组顺序或“最后一个节点”。

将非根目录文件夹标记为 `progress` 前必须：

1. 显示当前路径和将移动到的项目根目录目标路径；
2. 明确说明移动会改变现有路径；
3. 获得用户确认；
4. 预检目标不存在、来源仍位于项目内且不是快捷方式解析后的外部目录；
5. 使用安全移动，移动成功后更新同一节点的 `relativePath`，不创建新的关系身份。

快捷方式本身可以作为普通文件被浏览，但不得把快捷方式解析出的外部目录直接移动、覆盖、接管为项目文件夹或写入版本关系。检测到来源是 junction、symlink、`.lnk` 或其他重解析入口且目标位于项目外时必须阻止操作，并保留原位置。

## 4. 选片

手动选片必须由当前选择明确确定一个来源文件夹。“从文件名选片”分别提供图片和视频来源，默认匹配项目内的 `RAW` 与 `MOV` 文件夹，用户仍可改为其他项目内文件夹或关闭其中一类。输出节点规则相同：

- 输出物理文件夹位于来源文件夹同级；普通来源使用 `来源文件夹名_选片`，`RAW` 与 `MOV` 为兼容既有工作流分别使用 `图片选片` 与 `视频选片`。
- 输出节点 `role='selection'`、`parentNodeId=来源节点 ID`、`relationKind='auxiliary'`。
- 已存在目标文件永不覆盖；逐文件标记为 `skipped_existing` 并在结果中报告。
- 同一来源再次选片时复用已绑定的 selection 节点，增量复制未存在文件。
- 若目标名称已被未绑定文件夹或另一来源节点占用，任务在写入前以 `output_name_conflict` 失败；不得自动编号、覆盖或错误接管。用户处理冲突后重试，因而成功输出名称始终满足统一格式。

媒体类型处理：

- 图片目录：复制支持的图片/RAW，其他文件报告为 `unsupported`。
- 视频目录：复制支持的视频，其他文件报告为 `unsupported`。
- 混合目录：图片、RAW 和视频进入同一个 selection 输出节点，保持相对子目录；媒体类型记录在结果项中。
- 不同父目录下的同名来源文件夹分别在各自同级位置产生同名的 `来源文件夹名_选片`，关系通过来源节点 ID 区分。
- 同一输出相对路径发生同名冲突时，先成功写入者保留，后续项标记 `destination_collision`；不得覆盖。

新的主版本只能连接到用户选择的最近主分支父节点（`main` 边），不能以 `selection`/`auxiliary` 节点作为父节点。若用户从 selection 上触发“新建进度”，界面必须解析并显示其最近仍存在的主分支祖先，要求用户确认该主分支父节点。

## 5. stale 传播

媒体变化包括受支持媒体的新增、删除、重命名或内容指纹变化。已跟踪当前文件夹发生任一媒体变化时，自身从 `ready` 变为 `stale`；已经处于处理、修复或禁用状态时不得被该规则错误覆盖。

父版本新增媒体时，沿 `main` 边向直接子节点检查：仅当子节点 `role='progress'`、`trackingPolicy.trackingEnabled=true` 且 `copyMissingFromParent=true` 时，子节点从 `ready` 变为 `stale`。该子节点变为 stale 本身不是“新增媒体”，不能继续级联；待其刷新并真正补入媒体后，再由真实文件变化驱动下一层。`auxiliary` 边和 `selection` 节点完全不参与传播。

## 6. 确认跟踪图片

compare/refresh 会话中的每个媒体项目必须具有以下状态之一：

| 状态 | 含义 | 可提交动作 |
| --- | --- | --- |
| `recognized` | 已可靠关联到父版本媒体 | 接受默认关联或调整 |
| `accepted` | 用户已确认关联/新素材决定 | 可提交 |
| `pending_confirmation` | 软件判断为新素材，等待用户确认 | 必须用户接受或拒绝 |
| `missing_reference` | 父引用不存在或无法读取 | 修复引用或拒绝 |
| `rejected` | 用户明确排除 | 提交时不纳入跟踪 |

软件判断为新素材的项目默认必须是 `pending_confirmation`，不得自动变为 `accepted`，更不得在未经确认时提交。存在任意 `pending_confirmation` 或 `missing_reference` 项时，“确认并提交”必须禁用。用户的逐项决定需持久化在会话结果中，以支持关闭面板后恢复。

## 7. 删除生命周期与树重连

普通文件列表刷新、版本快照读取和 renderer effect 都是只读协调过程，不得自动调用 `unregister`。历史上已存在的无父 `progress` 必须原样保留并明确提示修复：用户可选择合法父节点，或显式取消版本登记；两条路径都不得删除物理文件。游离进度不能成为新进度或预览关系的来源。显式断开普通进度必须走受限的 `unregister(progressId)`，不能先持久化一个新的无父 progress。

仍被 structural children 引用的父节点不得转换为 companion、artifact、workflow、broll 或不兼容媒体类型；父端更新触发器与所有受限角色转换命令都必须在写入前拒绝。仅更新 `missingSince` 不改变结构语义，可以保留现有关系供恢复。

维护任务在找不到存活替代父节点时必须保留 tombstone 与下游关系供修复，不能把下游静默改成根节点。以下生命周期规则仅适用于不会制造非法游离节点的记录：

detached versioning store 不依赖被抽取器剥离的 FK cascade。删除失效进度必须在同一事务中显式清理 batch items/operations、tracking sessions/items、图边、导入 slot 与布局投影，再删除 batch 和 progress；任一步失败必须整体回滚。

物理文件夹被确认消失后：

1. 立即从版本树和可选父节点列表隐藏；
2. 数据库记录保留为 tombstone（`deletedAt` 非空），不立即物理删除；
3. 下次数据库维护任务清理不再被任务/审计记录引用的 tombstone；
4. 同一 `folderIdentity` 或新建文件夹可直接接管可兼容 tombstone 的节点 ID/关系，不显示“替换版本”警告；接管必须清空 `deletedAt` 并更新路径与身份；
5. 展示主分支时，tombstone 的主分支后代连接到最近仍存在的 `main` 祖先。该重连仅是 UI 投影，不改写后代持久化的 `parentNodeId`。

selection 后代不跨越已删除节点伪装成主分支。若不存在仍存活的主分支祖先，则该存活主节点作为可见根节点显示。

## 8. 后台任务与会话协议

compare 与 refresh 的启动响应必须轻量且一致：

```ts
interface StartTrackingTaskResult {
  taskId: string
  sessionId: string
}
```

- `taskId` 用于任务中心的进度、取消、失败和完成通知；`sessionId` 用于读取完整匹配结果和用户决定。
- compare/refresh 可从面板“缩小到后台”。缩小只关闭当前面板，不取消任务；任务中心提供恢复面板入口。
- 后台任务 metadata 只保存计数、阶段、节点 ID、`sessionId` 和短错误摘要。大量匹配项目、文件路径列表或缩略图数据不得塞入 metadata。
- 完整结果通过独立接口按 `sessionId` 分页读取，例如 `getTrackingSession(sessionId, cursor, limit)`；用户决定也按 session 写入。
- `cancelTask(taskId)` 必须可取消 compare/refresh；取消后保留足以解释结果的会话摘要，并按开始前状态恢复节点。
- 失败任务在任务中心显示失败原因和“恢复面板”；可恢复失败继续使用同一 `sessionId`，不可恢复失败允许以新任务重试。
- compare 完成后节点进入 `pending_confirm`，任务中心提供“打开确认面板”；不得在后台自动提交。
- 提交使用同一 `sessionId`，进入 `committing`；幂等键至少包含 `sessionId`，重复点击不得产生重复关系或重复复制。

## 9. 实现验收约束

- 数据库迁移必须显式写入 `role`、`relationKind`、三个策略字段、`trackingState` 和 tombstone 字段。
- 用途写入必须覆盖“选择用途 → 提交 → reload/effect → 同一节点仍持久存在”；同时覆盖三模式字段隔离、broll mixed/无边/无跟踪、无父 progress 拒绝以及旧游离 progress 不被刷新删除。
- renderer 只能提交项目相对路径、受限用途命令和项目内节点 ID；不得提交 `nodeRole`、绝对路径或任意边类型。Electron/后端根据受限命令推导角色和关系。
- 若节点/文件已持久化而后台跟踪启动失败，界面必须报告“登记/导入已成功，跟踪启动失败且可重试”，不得把部分成功误报为创建或导入失败。
- API、数据库和界面行为测试必须覆盖 auxiliary 禁用、状态文案、stale 传播、新素材确认门禁、非根目录移动预检、selection 冲突、tombstone 隐藏/接管以及 task/session 分离。
- 生产界面字段、状态和按钮行为以 `docs/prototypes/tool-panels/README.md` 为实现清单；视觉参考可直接打开同目录 `index.html`。

## 10. 跟踪确认预览契约

```ts
interface TrackingConfirmationPreviewState {
  selectedItemId?: string;
  comparisonMode: 'side-by-side' | 'overlay';
  swapped: boolean;
  zoom: number;
}
```

该状态仅属于 renderer，不得持久化到数据库。数据库只保存用户决定和媒体关系；会话项目保留 `sourceName`、`referenceName`、`targetName` 与状态，不保存二进制图片或预览 URL。预览路径在读取时通过 `progressId`、`parentProgressId` 对应的进度文件夹和会话项目文件名解析，不得通过文件夹名或版本编号推断关系。

后台任务 metadata 只保存 `sessionId`、`progressId`、`processedCount` 和 `totalCount`。完整项目、路径列表和预览数据必须按 `sessionId` 从会话接口分页读取。
