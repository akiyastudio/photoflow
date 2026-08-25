# Component Host V1

> 新开发已弃用。已安装 V1 组件继续通过隔离兼容适配器运行。新组件请使用 [插件开发教程](PLUGIN_DEVELOPMENT.md) 和 [Host API V2](PLUGIN_HOST_API.md)。

Component Host V1 是旧版可选组件 UI 路径。PhotoFlow 读取组件 `component.json`，在项目目录工作区顶部的 **UI 组件** 分组渲染一个宿主管理按钮，并打开独立全页组件标签。组件不能向 PhotoFlow 渲染层贡献 React 代码。

V1 不支持文件列表装饰、右键菜单、媒体预览覆盖层、普通设置页、DOM 注入或高级视频播放。缺少 `componentHost` 的旧原生 `apiVersion:1` 组件继续走旧进程能力路径。

## 清单合约

```json
{
  "apiVersion": 1,
  "id": "example-component",
  "version": "1.2.3",
  "componentHost": {
    "contractVersion": 1,
    "compatibility": {
      "minHostApiVersion": 1,
      "maxHostApiVersion": 1
    },
    "contributions": [
      {
        "type": "workspace.toolbarAction",
        "id": "open",
        "label": "示例组件",
        "pageId": "main"
      },
      {
        "type": "component.fullPage",
        "id": "main",
        "title": "示例组件",
        "entry": "ui/index.html"
      }
    ]
  }
}
```

宿主在组件根目录下动态发现清单；UI 组件 ID 和业务版本不会编译进宿主目录。V1 要求恰好一个工具栏动作连接恰好一个全页。未知贡献、API 范围不兼容、ID 格式错误、重复贡献、缺失文件、符号链接和组件根外入口都会使整套 UI 注册失败。

## 隔离与生命周期

每个页面运行在宿主管理的 `WebContentsView` 中，设置 `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webviewTag:false`。新窗口、导航、WebView 和权限均被拒绝，组件不能选择 preload。

宿主把每个 SDK 请求绑定到准确的组件 `webContents` 发送方。`window.photoFlowComponent` 只暴露 `contractVersion`、`getContext()`、`rpc()`、`onEvent()`、`onActivate()`、`onDeactivate()`。RPC 必须版本化、属于单一组件 ID、来自显式映射，并在调度前过滤字段。工作区和项目身份来自绑定页面。未知方法、事件主题、字段、发送方和组件所有者默认拒绝。SDK 不暴露 `ipcRenderer`、任意通道、任意文件系统原语或主渲染层 `electronAPI`。

页面键为 `componentId + 规范化工作区路径 + projectId`。重复点击工具栏会聚焦已有页面。关闭页面会销毁 view；关闭项目最后页面或删除/关闭项目会关闭该项目全部组件 view。组件 DOM 永不挂载进 PhotoFlow React 树。

## 一方团片协作包

`extensions/team-retouch` 是首个一方 UI 包。清单、文案、图标、独立渲染源码、Python 后端、模型、算法和高级环境脚本都位于组件包输入中。`npm run build:team-retouch-renderer` 生成独立静态渲染层；`scripts/build-components.cjs` 在原生运行时前构建并复制到包的 `ui/`。生产清单只指向已安装组件内的 `ui/index.html`。

主 React 渲染层不包含团片管理器、身份管理器、步骤 UI、工具栏/右键动作、嵌入面板、设置贡献或 `workspace-team-*` preload API。它只渲染清单生成的按钮和宿主管理页面外壳；检测、身份、工作流、回传、合并和设置 UI 都由组件页面拥有。

清单声明的 `team.*` RPC 均由 `extensions/team-retouch/service.cjs` 实现，不映射到 `workspace-team-*` 渲染 IPC。检测、身份推断、重新裁切、合并、回传导入和安装后高级运行时探测都在组件服务内运行。

高级 WSL 环境有独立 `advancedRuntime.apiVersion`，不等同组件发行版本。新离线包必须匹配该 API；旧包只在组件版本进入已审查 `compatibleLegacyComponentVersions` 时兼容，从而避免 UI/服务发布强制重建多 GB 环境。

宿主中剩余团片引用只用于兼容和信任边界：备份/恢复保留旧数据库；系统模块验证安装包发现与清理；生命周期服务验证高级包和路径；项目能力服务把存储、媒体/输出、对话框、设置和任务事件绑定到已安装清单和当前项目，不实现团片算法或持久化。

卸载组件不会删除数据；组件缺失或清单错误只会移除动态入口。
