# 团片协作外置页面迁移对照

可信基准：`fef15e4^` 的 `TeamRetouchManager.tsx`、`PersonIdentityManager.tsx` 及其直接 UI 依赖。迁移原则是保留基准 JSX、文案、状态与交互，只将主程序 `electronAPI` 调用改接 `legacy-api.ts` 的版本化组件 RPC。

| 原页面能力 | 外置 renderer 对应实现 | RPC / 宿主边界 |
| --- | --- | --- |
| 原图、工作图懒加载和失败重试 | `legacy/TeamRetouchManager.tsx` 的 `useLazyPreview`、`PatchPreview` | `team.media.authorize.v1`，只传照片/版本/任务 ID |
| 人物框叠加、多人颜色和点击标记 | `PatchPreview`、`PhotoPersonOverlay` | 工作区公开任务数据，不传文件路径 |
| 全窗口浏览 | `FullscreenImageViewer`、`ImageZoomButton` | 授权媒体 URL |
| 裁剪拖动、四边/四角缩放和数值调整 | `CropEditor` | `team.patch.update.v1` |
| 身份候选整组选择、同图去重、改名和删除 | `IdentityPicker` 及原状态机 | `team.identity.*.v1` |
| 人物顺序拖拽、同周安排、任务生成/取消 | `legacy/PersonIdentityManager.tsx` | `team.workflow.*.v1` |
| 返图批量选择、五种对比、候选确认/忽略 | `WorkflowReturnReviewDialog`、`ImageComparisonView` | 返图审核 ID + `team.workflow.return-*.v1` |
| 输出进度选择和全部完成人物合并 | `useTeamOutputProgress`、`TeamOutputProgressPicker` | `project.progress.*.v1`、`team.patch.merge.v1` |
| 原右上角关闭位置 | 两个历史页头的唯一有意 UI 变更：设置图标 | 组件内 `TeamSettingsDialog` |

媒体文件路径不会暴露给 renderer。适配层为旧组件构造仅存在于内存中的 `photoflow-ref:` 引用，再在预览/打开动作中还原为 ID 参数。项目数据库、任务、媒体、版本、工作流和输出进度格式均未修改。
