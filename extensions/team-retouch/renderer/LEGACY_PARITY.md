# 团片协作当前页面契约

生产 UI 暂时继续由 `legacy-main.tsx` 与 `legacy/*` 文件名承载，以减少首发前的大规模组件拆分风险；这些文件名不是兼容承诺。当前行为由构建、类型检查和交互模型测试验证，不再以保持旧源码形状为测试目标。

- Renderer 只通过 `team.*.v1` 私有 RPC 与组件服务通信；公共 Host capability 名和返回值不带 Host API 版本号。
- 媒体引用固定为当前八段 `photoflow-ref:` 形状，并仅使用对象参数调用。
- 初始化读取当前 workspace，再登记本次明确选择；缺失文件以诊断卡显示。
- 工作流 manifest 必须是 `version: 2` 且精确绑定 `projectId`，不会按项目名称或状态回退。
- task-chain reconcile、返图审核、输出 ownership、revision lease/fence 与崩溃恢复仍是当前功能。
- 生产 UI 的后续文件重命名和去 `@ts-nocheck` 属于独立重构，不影响本次首发契约收敛。
