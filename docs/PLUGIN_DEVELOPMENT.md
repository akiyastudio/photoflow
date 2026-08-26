# PhotoFlow 插件（组件）开发教程

PhotoFlow 把可选扩展包称为 **组件（Component）**。文件名保留“Plugin”便于检索；新包必须使用 Component Host V2，并且不能导入 PhotoFlow 的 React 渲染层或 Electron 主进程代码。

## 快速开始

1. 把 `examples/hello-component` 复制到以组件 ID 命名的目录。
2. 普通 V2 组件可继续使用 Host API `2`；设置页需要 Host API `3`；声明顶部通知能力需要 Host API `4`；项目文件、元数据、版本图和评分只读扩展需要 Host API `5` 与 `minHostApiVersion:5`。
3. 添加一个 `workspace.toolbarAction`、一个与之相连的 `component.fullPage`、包内 UI 入口和服务入口。需要全局设置时，可额外贡献 `application.settingsPage`。
4. 声明全部服务 RPC、Host 能力、权限和发出的事件。未声明的访问会默认拒绝。升级历史数据时，可声明 `component.storage.previous.v1` 和/或 `project.output.existing.v1` adoption grant；不要把组件业务表或路径字段加入宿主代码。
5. 运行 `node scripts/mock-component-service.cjs path/to/service.cjs`，不启动 Electron 也能验证按行分隔的服务协议。
6. 把目录放入 PhotoFlow 用户组件目录；源码开发时也可以放到 `extensions/`。发行包使用 `component.json`；源码开发可以使用 `component.template.json` 和现有组件构建流程。

完整示例包含静态页面和 Node 服务。页面只调用 `window.photoFlowComponent`，服务向宿主请求一页媒体。`component-sdk/index.d.ts` 提供全部 V2 能力的请求、结果、错误、事件和 JSONL 帧映射；`component-sdk/service.cjs` 为服务后端提供 `callHost`、`acceptFrame` 和 `failAll`。

## 包结构

```text
hello-component/
  component.json
  service.cjs
  ui/index.html
  ui/icon.svg          # 可选，只允许 PNG 或被动 SVG
```

清单路径都是包内相对路径。符号链接、路径穿越、远程页面或图标、主动 SVG、缺失文件和未知贡献类型都会使整套 UI 注册失败。组件不能选择自己的 preload。

## UI 教程

```ts
import { host, assertHostApiV2, assertHostApiV4 } from '../../component-sdk/index.js';

const context = await host.getContext();
assertHostApiV2(context);
const page = await host.rpc('my-component.load.v1', { cursor: null });
const stop = host.onEvent('my-component.progress.v1', update => render(update));
if (host.notify) {
  assertHostApiV4(context);
  await host.notify({ tone: 'success', message: '设置已保存', dedupeKey: 'settings.saved' });
}
window.addEventListener('pagehide', stop, { once: true });
```

UI 运行在沙箱 `WebContentsView` 中，Node 集成、WebView、任意导航、新窗口和浏览器权限都被关闭。使用上下文中解析后的明暗主题，并监听主题/上下文变化。控件应支持键盘操作、显示可见焦点、为表单提供标签、尊重“减少动态效果”，并且不能假设宿主页面始终激活。页面停用或销毁时释放计时器和订阅。

渲染层通常调用组件自有 RPC，而不是直接调用 Host 能力。唯一的受控 UI 快捷桥是 API4 `notify`：它只接受严格的纯文本结构，不能携带 HTML、回调、URL、路径或任意 channel。组件服务是后端协议端点，只能请求清单授权的 Host 能力；只有后端自身产生短状态时才使用 `notifications.v2`。长任务和确认仍分别使用 `tasks.v2` 与 `dialogs.v2`。

### 可选的应用设置页

`application.settingsPage` 是 Host API 3 特性，会在已安装且校验成功后动态出现在“组件管理”之后。它与项目整页一样使用独立的 sandboxed `WebContentsView` 和组件 preload，但 `context.surface` 为 `application.settings`，项目字段为空。

```json
{
  "type": "application.settingsPage",
  "id": "settings",
  "label": "示例组件",
  "title": "示例组件设置",
  "entry": "ui/settings.html",
  "rpcMethods": ["hello.settings.get.v1", "hello.settings.update.v1"]
}
```

`rpcMethods` 必须是 `service.rpcMethods` 的子集，且只有这些方法能从设置页调用。设置 surface 的服务再向 Host 请求时，默认拒绝所有项目、媒体、存储、任务和事件能力；只允许清单已授权的 `component.settings.v2`、`component.lifecycle.v2`、确认对话框和 API4 通知。不要在此 surface 调用项目 RPC。

## 后端服务教程

服务通过 stdin/stdout 上的 UTF-8 JSON Lines 通信：

1. 初始化后输出 `{ "type":"ready", "protocolVersion":1 }`。
2. 接收带不透明请求 ID、已声明版本化方法、JSON 载荷和无路径项目上下文的 `request`。
3. 返回 `response`；需要宿主资源时，发送绑定请求 `parentId` 的 `capability`，并等待 `capability-response`。
4. 日志写 stderr；stdout 只输出协议帧。

完整实现见 `examples/hello-component/service.cjs`。普通同步请求 60 秒超时，帧和载荷上限 2 MiB。长任务应启动 `tasks.v2` 操作，频繁保存检查点，把控制权还给 UI，并在取消或重启后从最后检查点恢复。

Host API 5 服务可在清单显式声明后调用只读扩展，例如 `callHost(parentId, 'project.files.search.v1', { query:'xmp', pageSize:50 })`。同时声明 `project.files.read`；媒体元数据复用 `project.media.read`，版本与评分分别声明 `project.versions.read`、`project.media.ratings.read`。这些结果只含项目虚拟相对路径和稳定 ID，不要尝试从游标、媒体引用或图节点推导绝对路径。

## 安全的“媒体 → 版本”流程

1. 使用 `project.media.page.v2` 分页读取媒体。
2. 使用 `variants:[]` 取得稳定媒体元数据。只有真正需要像素或 URL 时，才解析 `thumbnail`、`preview` 或 `original`。
3. 服务需要私有文件副本时，用 `project.input.tokens.v2` 交换返回的短时、一次性输入令牌。
4. 调用 `project.output.v2` 的 `stage`；在返回的私有 stage 目录下写入文件；通过 `write` 登记每个文件，然后 `validate`。
5. 使用稳定幂等键调用 `commit`。宿主只会把已声明的相对目标发布到绑定项目下。
6. 可选：使用返回的 commit/artifact ID 和另一个稳定幂等键调用 `version.create.v2`。
7. 对放弃的 stage 调用 `rollback`。

stage 元数据与登记文件保留 24 小时，因此宿主重启后可以继续 `validate`、`commit` 或 `rollback`。保存返回的 `stageId`、`commitId` 和 artifact ID，而不是私有路径。已提交制品可以通过 `dialogs.v2` 打开或显示；迁移时可用 `materializeOwned` 校验并导入私有存储。系统从不接受任意输出路径。

插件私有存储下的媒体使用 `component.media.v2`；项目进度节点及来源关系使用 `project.progress.v2`。进度创建可以携带扁平 `sourceMetadata`：`category`、`role`、`displayName` 和 `parentCapability`。文本最多 128 字符；`parentCapability` 只允许 `structural`、`workflow-input` 或 `none`。宿主写入绑定的 `componentId`，省略或空元数据默认采用结构化进度，并拒绝未知或嵌套字段。

如果 `component.storage.v2` 返回 `adoption.state === "pending"`，尚未授予任何组件存储路径。显示迁移状态，以 500–1000 ms 有界退避轮询，并拒绝所有依赖存储的读写和变更。不要创建公布的组件目录、猜测 `dataPath`/`databasePath` 或启动第二次复制。提交后先验证同组件收据再重写私有路径；项目输出迁移应单独记录并增量执行。宿主保留 V1 来源，并能在中断后恢复复制日志。

替换项目输出必须显式提供 `replace:true`、`previousCommitId`、`previousArtifactId` 和 `expectedDigest`。宿主只替换由旧提交收据拥有、且当前字节仍匹配的目标，并在多文件事务期间记录旧内容。不要通过自行删除目标实现覆盖。

不要把项目路径作为组件业务身份持久化。保存 PhotoFlow ID 和组件自有元数据。token、cursor、stage、commit 和 artifact ID 都是不透明值，并限定在一个组件和项目范围内。

## 测试与发布

- `npm run test:component-host-v2` 先检查 SDK 类型，再检查协商、权限、外部/私有媒体、stage 过期与恢复、提交日志与受控替换、版本幂等、进度、任务、对话框、事件、真实媒体服务组合和服务模拟器。
- `npm run test:component-host`、`npm run test:component-service`、`npm run test:electron-security` 和 `npm run test:architecture` 覆盖隔离与兼容性。
- 打包前用 `electron/contracts/schemas/component-manifest-v2.schema.json` 校验清单。
- 安装包只包含构建后的 UI、服务和运行资源；为清单声明的生命周期动作计算哈希；在干净用户配置中安装，测试取消、重启，再用真实 V1 数据测试升级与降级。
- 每次发布提升组件业务版本。只有语义破坏性变化才提升 RPC/事件的 `.vN`；迁移期新增版本应与旧版本并存。

旧宿主业务适配器已经移除。组件只能通过版本化 Host API 与 adoption grant 运行。
