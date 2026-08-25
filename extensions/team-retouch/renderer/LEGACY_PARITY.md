# 团片协作外置页面迁移对照

可信基准：外置提交 `fef15e4` / `e6eb194` 的共同直接父提交 `7517789`。该提交是旧 `TeamRetouchManager.tsx`、`PersonIdentityManager.tsx` 及其直接 UI 依赖仍由 `ProjectWorkspace` 实际挂载的最后版本。迁移原则是保留基准 JSX、文案、状态与交互，只将主程序 `electronAPI` 调用改接 `legacy-api.ts` 的版本化组件 RPC。

| 原页面能力 | 外置 renderer 对应实现 | RPC / 宿主边界 |
| --- | --- | --- |
| 原图、工作图懒加载和失败重试 | `legacy/TeamRetouchManager.tsx` 的 `useLazyPreview`、`PatchPreview` | `team.media.authorize.v1`，只传照片/版本/任务 ID 与严格 `preview`/`original` 意图；缩略图不回退原图 |
| 人物框叠加、多人颜色和点击标记 | `PatchPreview`、`PhotoPersonOverlay` | 工作区公开任务数据，不传文件路径 |
| 全窗口浏览 | `FullscreenImageViewer`、`ImageZoomButton` | 授权媒体 URL |
| 裁剪拖动、四边/四角缩放和数值调整 | `CropEditor` | `team.patch.update.v1` |
| 身份候选整组选择、同图去重、改名和删除 | `IdentityPicker` 及原状态机 | `team.identity.*.v1` |
| 人物顺序拖拽、同周安排、任务生成/取消 | `legacy/PersonIdentityManager.tsx` | `team.workflow.*.v1` |
| 返图批量选择、五种对比、候选确认/忽略 | `WorkflowReturnReviewDialog`、`ImageComparisonView` | 返图审核 ID + `team.workflow.return-*.v1` |
| 输出进度选择和全部完成人物合并 | `useTeamOutputProgress`、`TeamOutputProgressPicker` | `project.progress.*.v1`、`team.patch.merge.v1` |
| 原右上角关闭位置 | 两个历史页头的唯一有意 UI 变更：设置图标 | 组件内 `TeamSettingsDialog` |

媒体文件路径不会暴露给 renderer。适配层为旧组件构造仅存在于内存中的 `photoflow-ref:` 引用，再在预览/打开动作中还原为 ID 参数。项目数据库、任务、媒体、版本、工作流和输出进度格式均未修改。

打开范围沿用历史 `openTeamRetouch()`：已有登记历史、组件当前已打开条目与用户本次明确选择的图片按路径去重合并。组件不递归枚举当前文件夹或整个项目。Host 上下文仅传递经过校验的当前目录、明确选择路径和来源页 ID。

主程序把当前设置解析后的 `light` / `dark`（包括 `system` 的实时解析结果）通过版本化组件上下文和受控变更事件发送给沙箱页面。独立样式包含旧 `src/index.css` 中团片实际依赖的 `html.dark` 背景、文字、边框、输入和弹窗覆盖。
