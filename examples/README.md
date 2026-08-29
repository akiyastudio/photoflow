# Component Host 示例

每个示例都是一个独立、最小的组件包，固定包含 `component.json`、`service.cjs` 和 `ui/index.html`。按目标选择一个示例复制即可，不需要把整个目录打包进组件。

| 目录 | 用途 | 申请的 Host 能力 |
| --- | --- | --- |
| `hello-component` | 入门组件：从 UI 调用服务并读取一页项目媒体 | `project.media.page.v7` |
| `panel-only-v7` | 只贡献文件页侧边面板，不创建工具栏入口 | 无 |
| `host-api-v7` | 演示多个 Host 入口共享页面和受限入口上下文 | 无 |
| `project-read-v7` | 分页读取授权范围内的非媒体文件与 sidecar | `project.files.page.v7` |
| `project-write-v7` | 使用 revision 和幂等键写入媒体评分 | `project.media.ratings.write.v7` |
| `declarative-settings-v1` | 使用宿主原生渲染并保存标准设置表单 | `component.settings.v7` |

## 快速验证

在仓库根目录验证入门服务的 JSON Lines 协议：

```powershell
node scripts/mock-component-service.cjs examples/hello-component/service.cjs
```

运行示例涉及的 Host API、面板和声明式设置契约测试：

```powershell
node scripts/test-component-host-v7.cjs
node scripts/test-component-panel-plugin.cjs
node scripts/test-component-settings-form-contract.cjs
node scripts/test-component-declarative-settings-host.cjs
```

真实组件应只声明实际调用的能力和对应权限。需要组合多个功能时，以这些最小示例为起点逐项增加声明。
