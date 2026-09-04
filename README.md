<div align="center">
  <img src="public/app-logo.svg" alt="照片流图标" width="60" />
  <h1>PhotoFlow 插件开发</h1>
  <p>使用 Component Host V2 制作隔离、可安装、可独立升级的照片流插件</p>
  <p>
    <a href="docs/PLUGIN_DEVELOPMENT.md">开发教程</a>
    · <a href="docs/PLUGIN_HOST_API.md">Host API</a>
    · <a href="examples/README.md">示例目录</a>
  </p>
</div>

照片流把可选扩展包称为“组件（Component）”，在面向使用者的页面中也称为“插件”。新插件统一使用 **Component Host V2**：界面运行在独立沙箱页面中，业务后端作为受监管子进程运行。Host API 的能力与权限是正常组件访问宿主资源的契约和最小授权机制。

组件 UI 不能导入照片流 React 渲染层或 Electron 主进程代码，也不能取得任意 IPC；所有未在清单中声明的 RPC、能力、权限和事件都会默认拒绝。这个沙箱只保护 UI `WebContents`。组件 service、生命周期动作和 executable 是用户主动安装的受信本机代码，以当前用户权限运行，能够绕过 Host API 直接使用用户可访问的文件、网络和进程能力；“受监管”表示宿主负责启动、协议、超时和停止，不是针对恶意进程的 OS 沙箱。本项目当前不承诺安全运行不受信第三方市场插件。

> [!IMPORTANT]
> 所有组件通过当前 Host API 的稳定能力名称访问宿主资源。旧数据只能通过显式 adoption grant 迁入组件私有存储。

## 快速开始

1. 复制 `examples/hello-component`，并把目录改成自己的组件 ID。
2. 在 `component.json` 中声明组件入口，并直接使用无版本后缀的 Host 能力名称。
3. 声明一个 `workspace.toolbarAction` 或 `component.sidePanel`、一个相连的 `component.fullPage`、包内 UI 入口和服务入口。仅面板插件可以不声明 toolbarAction。
4. 显式列出服务 RPC、Host 能力、权限和事件。
5. 用服务模拟器验证 JSON Lines 协议：

```powershell
node scripts/mock-component-service.cjs examples/hello-component/service.cjs
```

6. 将插件目录放入照片流用户组件目录；源码开发时也可以放入 `extensions/` 并使用现有组件构建流程。

## 最小包结构

```text
hello-component/
  component.json
  service.cjs
  ui/index.html
  ui/icon.svg          # 可选；只允许 PNG 或被动 SVG
```

清单中的路径都是包内相对路径。符号链接、路径穿越、远程页面/图标、主动 SVG、缺失文件、未知贡献类型或包外入口都会使整套组件注册失败。组件不能选择自己的 preload。

## 清单骨架

```json
{
  "apiVersion": 1,
  "id": "hello-component",
  "version": "0.1.0",
  "componentHost": {
    "contractVersion": 2,
    "contributions": [
      {
        "type": "workspace.toolbarAction",
        "id": "open",
        "label": "示例插件",
        "pageId": "main"
      },
      {
        "type": "component.fullPage",
        "id": "main",
        "title": "示例插件",
        "entry": "ui/index.html"
      }
    ],
    "service": {
      "protocolVersion": 1,
      "runtime": "node",
      "entrypoints": { "default": "service.cjs" },
      "rpcMethods": ["sample.context.v1", "sample.media-page.v1"],
      "capabilities": ["project.media.page"],
      "permissions": ["project.media.read"],
      "events": []
    }
  }
}
```

实际字段和机器约束以 `electron/contracts/schemas/component-manifest-v2.schema.json` 为准。

标准设置优先使用由宿主原生渲染和保存的 `application.settingsForm`；完整示例见 `examples/declarative-settings-v1`。只有确实需要自定义交互时才使用沙箱化的 `application.settingsPage`。

## 运行模型

```text
插件 UI（沙箱 WebContentsView）
        │ window.photoFlowComponent.rpc()
        ▼
组件桥接与 RPC 白名单
        │ 私有 JSON Lines
        ▼
插件服务（受监管子进程）
        │ 已声明 Host capability
        ▼
PhotoFlow 项目 / 媒体 / 输出 / 版本 / 任务
```

图中的沙箱边界只覆盖插件 UI。服务进程是受信本机代码；Host capability 是组件互操作契约，不是限制恶意服务进程的安全边界。

### 插件界面

界面只使用 `window.photoFlowComponent`：

```ts
import { host, assertHostApi } from '../../component-sdk/index.js';

const context = await host.getContext();
assertHostApi(context);
const page = await host.rpc('my-component.load.v1', { cursor: null });
const stop = host.onEvent('my-component.progress.v1', update => render(update));
if (host.notify) await host.notify({ tone: 'success', message: '设置已保存', dedupeKey: 'settings.saved' });
window.addEventListener('pagehide', stop, { once: true });
```

页面运行时关闭 Node 集成、WebView、任意导航、新窗口和浏览器权限。界面应跟随宿主主题，支持键盘与可见焦点，页面停用或销毁时释放订阅和计时器。

`component.sidePanel` 会在当前文件页的统一工具面板中打开，并绑定触发时的目录、选择项和文件页。宿主负责面板外框、插件图标、标题、遮罩、关闭和尺寸同步；组件页面只绘制内容区域。同一项目的不同文件页拥有独立面板实例。完整的仅面板示例见 `examples/panel-only`。

普通偏好优先使用宿主原生渲染的 `application.settingsForm`；复杂授权、环境安装或诊断可以通过同一表单的 `customPage` 扩展。自定义页面复用 `component-sdk/ui.css`，CSS 类不会授予任何 Host 能力。

### 插件服务

服务通过 UTF-8 JSON Lines 使用 stdin/stdout：

1. 初始化后发送 `{"type":"ready","protocolVersion":1}`。
2. 接收带不透明 ID、版本化方法、JSON 载荷和无路径项目上下文的 `request`。
3. 需要宿主资源时发送绑定父请求的 `capability`，等待 `capability-response`。
4. 最终返回 `response`。stdout 只用于协议帧，日志写 stderr。

普通同步请求 60 秒超时，单帧与载荷上限为 2 MiB。长任务使用 `tasks`，定期保存检查点并支持取消、重启后恢复。

## 常用 Host 能力

| 能力 | 权限 | 用途 |
| --- | --- | --- |
| `project.media.page` | `project.media.read` | 分页读取项目媒体 |
| `project.media.variants` | `project.media.read` | 解析缩略图、预览或原图 |
| `project.input.tokens` | `project.input.read` | 把受限输入复制进私有存储 |
| `project.output` | `project.output.write` | 暂存、写入、校验、提交、回滚 |
| `version.create` | `project.version.create` | 从已提交制品创建版本 |
| `component.storage` | `component.storage` | 插件私有数据和 SQLite 位置 |
| `component.settings` | `component.settings` | 私有 JSON 设置 |
| `tasks` | `tasks` | 进度、检查点、取消与恢复 |
| `dialogs` | `dialogs` | 宿主管理的确认与文件选择 |
| `component.events` | `events` | 发送清单声明的版本化事件 |
| `component.lifecycle` | `component.lifecycle.read` | 读取版本、授权与生命周期状态 |
| `component.media` | `component.media` | 访问插件私有媒体 |
| `project.progress` | `project.progress` | 管理进度节点和来源关系 |
| `project.files.page` / `project.files.search` | `project.files.read` | Host API：只读分页/搜索非媒体文件、目录与 sidecar |
| `project.media.metadata` | `project.media.read` | Host API：读取白名单媒体元数据 |
| `project.versions.page` / `project.version.graph` | `project.versions.read` | Host API：只读版本快照与来源图 |
| `project.media.ratings` | `project.media.ratings.read` | Host API：批量读取实际评分支持 |
| `project.media.ratings.write` | `project.media.ratings.write` | 逐项 CAS 写入图片/RAW 评分 |
| `project.version.update` / `project.version.delete` | 独立版本写/删权限 | 原子版本 CAS 更新或高风险删除 |
| `project.import` | `project.import` | 一次性令牌的多文件事务导入 |
| `project.files.mutate` | `project.files.write` | 文件变更计划、提交、收据与撤销 |
| `project.media.process` | `project.media.process` | 视频时间线帧和 Office 图片提取 |
| `component.secrets` | `component.secrets` | safeStorage 加密的组件隔离秘密 |
| `network.fetch` | `network.fetch` | origin 白名单与秘密绑定的 HTTPS 请求 |
| `notifications` | `notifications` | 宿主管理的短暂纯文本状态 |

完整参数、限制、错误码和迁移规则见 [Host API 参考](docs/PLUGIN_HOST_API.md)。

Host API 的 P0 能力使用只读数据库快照，不触发媒体索引、迁移、baseline、repair 或路径同步写入。当前只覆盖项目物理目录；宿主管理的外链虚拟路径尚未开放。

## 安全的“媒体 → 输出 → 版本”流程

1. 使用 `project.media.page` 分页读取媒体。
2. 先用 `variants: []` 只取稳定元数据；需要像素时再请求 `thumbnail`、`preview` 或 `original`。
3. 原图请求返回短时、一次性输入令牌，通过 `project.input.tokens` 物化到插件私有存储。
4. 调用 `project.output` 的 `stage`，在私有阶段中生成文件，然后 `write` 登记并 `validate`。
5. 使用稳定幂等键 `commit`。宿主只会把已声明的相对目标原子发布到绑定项目。
6. 可选：用返回的 `commitId` 与 `artifactId` 调用 `version.create`。
7. 对放弃的阶段调用 `rollback`。

stage 元数据和登记文件保留 24 小时，宿主重启后仍可继续校验、提交或回滚。持久化时保存 PhotoFlow ID 与插件自己的业务元数据，不要把项目路径当成业务身份。

## 数据归属

- **宿主负责**：项目、媒体索引与变体、版本、文件安全、任务中心、组件生命周期和权限账本。
- **插件负责**：私有存储、设置结构、算法、UI 状态和业务实体。
- 只有宿主可以把内容发布进项目；双方都不能直接修改对方数据库。
- 卸载插件只删除代码，不自动删除插件数据。

## 当前组件

- `team-retouch`（团片协作）：人物检测、身份确认、协作返图与高分辨率合回。
- `video-playback-mpv`（高级视频解码）：无 UI 的独立 libmpv 播放后端。
- `video-tools`（视频处理）：文件页视频转码、无损切割及组件自有 FFmpeg 运行时。
- `video-transcription`（视频转文字）：本地批量语音识别、字幕搜索与受控 SRT 发布。

## 测试

```powershell
npm run test:component-host-api
npm run test:component-host
npm run test:component-service
npm run test:electron-security
npm run test:architecture
```

## 发布检查清单

- 用 `component-manifest-v2.schema.json` 校验清单。
- 安装包只包含构建后的 UI、服务和运行资源。
- 为清单声明的生命周期脚本计算并填写 SHA-256。
- 在干净用户配置中测试安装、停用/启用、取消、宿主重启、升级和降级。
- 使用真实 V1 数据验证迁移，并保留 V1 来源。
- 每次发布提升组件业务版本；只有破坏语义兼容时才提升 RPC 或事件的 `.vN`。

## 文档索引

- [插件开发教程](docs/PLUGIN_DEVELOPMENT.md)
- [Component Host API](docs/PLUGIN_HOST_API.md)
- [Component Service Protocol V1](docs/COMPONENT_SERVICE_PROTOCOL_V1.md)
- [架构边界](docs/ARCHITECTURE.md)
- [源码边界](docs/SOURCE_BOUNDARIES.md)

## 许可

照片流自主代码属于专有软件，Copyright (c) 2026 秋也，保留所有权利。插件作者仍需遵守 [LICENSE](LICENSE) 和所使用第三方依赖的许可证。
