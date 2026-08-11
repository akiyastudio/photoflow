# 版本跟踪 V2 数据与行为契约

状态：**生产实现的唯一 V2 契约**  
适用范围：版本跟踪、版本树、选片、后台 compare/refresh 任务及其确认面板。

本文中的字段名、枚举和值是生产端、Electron、数据库和界面之间的统一语义。实现可以增加纯展示字段或数据库索引，但不得用文件夹名称、`versionKey` 格式或其他推断替代本文明确规定的字段。

## 1. 统一节点与关系模型

```ts
type VersionNodeRole = 'original' | 'progress' | 'selection'
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

- `original`：原始素材节点，包括 RAW、JPG、MOV，以及第一次被加入关系的普通项目内文件夹。
- `progress`：主分支的版本进度节点。
- `selection`：选片产生的附属分支节点。

边类型由子节点的 `relationKind` 表示：

- `main`：主分支边，版本树用实线绘制。
- `auxiliary`：附属分支边，版本树用虚线绘制。
- 无父节点时 `parentNodeId` 与 `relationKind` 都必须为 `null`；有父节点时两者都必须非空。

`relationKind` 是权威值。不得通过 `versionKey` 是否包含下划线、文件夹名或节点角色反推边类型。V2 写入时，`progress` 节点必须使用 `main`，`selection` 节点必须使用 `auxiliary`；读取旧数据时由迁移明确补齐，不能在运行时继续推断。

## 2. 跟踪策略与界面状态

主分支节点必须持久化完整的 `trackingPolicy`，三个布尔值不能仅存在于面板临时状态：

- `trackingEnabled`：是否对该节点建立媒体跟踪。
- `renameFromParent`：提交时是否沿用父版本文件名。
- `copyMissingFromParent`：是否从父版本补齐当前版本缺失的媒体。

`renameFromParent` 和 `copyMissingFromParent` 只有在 `trackingEnabled=true` 时可为 `true`。`auxiliary` 节点必须持久化为三个值全为 `false`，界面必须禁用并解释以下能力不可用：图片跟踪、沿用上一版本文件名、补齐缺失媒体。后端也必须拒绝 auxiliary 节点开启任意一个选项，不能只依赖界面禁用。

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

状态转换的正常路径为：`disabled → pending_compare → pending_confirm → committing → ready`。刷新从 `stale → pending_compare` 开始。取消 compare 回到开始前状态；提交失败进入 `needs_repair` 或保留可恢复的 `pending_confirm`，由失败是否造成部分写入决定。

## 3. 任意项目内文件夹

任意项目根目录内的真实文件夹都可以作为关系来源，不要求名称符合版本规则。首次加入关系的普通文件夹先以 `original` 节点登记，再通过节点 ID 连接后续节点。

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
