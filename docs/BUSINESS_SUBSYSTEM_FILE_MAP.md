# PhotoFlow 业务子系统文件清单

本文按业务职责给产品源码指定“主归属”。同一个文件即使被多个模块调用，也只在主归属中列一次；确实无法单独归属的入口、公共类型和协议列在“横切基础层”。

统计与归类范围：`src/`、`electron/`、`python/`、`extensions/`、`component-sdk/`、`services/` 中受 Git 跟踪的产品源码。依赖目录、虚拟环境、模型、二进制、构建产物、普通文档和自动化测试不属于业务实现清单。

## 本次应用外壳发布集成变更登记

以稳定基线 `f3a0bf76d990ef98937243bd428376ba7f4893bb` 为比较起点，本次集成的全部变更文件如下（包括产品源码、测试、门禁、发布文档与本登记表）：

- `.gitattributes`
- `docs/BUSINESS_SUBSYSTEM_FILE_MAP.md`
- `docs/CLOUDBASE_ANALYTICS_GUIDE.md`
- `docs/legal/DATA_RETENTION_AND_RIGHTS_RUNBOOK_TEMPLATE.md`
- `docs/legal/PIPIA_TEMPLATE.md`
- `docs/legal/README.md`
- `docs/legal/RELEASE_APPROVAL_TEMPLATE.json`
- `docs/legal/RELEASE_EVIDENCE_GUIDE.md`
- `docs/legal/THIRD_PARTY_DISTRIBUTION_EVIDENCE.md`
- `electron/modules/system-ipc.cjs`
- `electron/modules/workspace-ipc.cjs`
- `electron/native/RecycleBinService.cs`
- `electron/native/RecycleBinService.manifest`
- `electron/services/config-mutation-service.cjs`
- `electron/services/recycle-bin-service.cjs`
- `electron/services/telemetry-service.cjs`
- `package.json`
- `scripts/build-recycle-bin-service.cjs`
- `scripts/check-project.cjs`
- `scripts/generate-release-json.cjs`
- `scripts/package-cloudbase-function.py`
- `scripts/publish-release.cjs`
- `scripts/source-boundary-policy.cjs`
- `scripts/test-cloudbase-function-package.cjs`
- `scripts/test-cloudbase-function-package.py`
- `scripts/test-config-mutation-service.cjs`
- `scripts/test-file-transfer.cjs`
- `scripts/test-global-search.cjs`
- `scripts/test-legal-release-evidence.cjs`
- `scripts/test-panel-task-sessions.cjs`
- `scripts/test-privacy-gate-contract.cjs`
- `scripts/test-privacy-revoke-telemetry.cjs`
- `scripts/test-recycle-bin-service.cjs`
- `scripts/test-settings-restore-model.mjs`
- `scripts/test-settings-ui-resilience.cjs`
- `scripts/test-source-boundaries.cjs`
- `scripts/test-telemetry-consent.cjs`
- `scripts/test-video-player-subtitles.cjs`
- `services/cloudbase/telemetry-function/README.md`
- `services/cloudbase/telemetry-function/index.js`
- `services/cloudbase/telemetry-function/package.json`
- `services/cloudbase/telemetry-function/retention-policy.js`
- `services/cloudbase/telemetry-function/test/privacy-database-integration.test.mjs`
- `services/cloudbase/telemetry-function/test/privacy-operations.test.mjs`
- `services/cloudbase/telemetry-function/test/release-blockers.test.mjs`
- `src/features/settings/SettingsFeature.tsx`
- `src/features/settings/restored-workspace-config.ts`

## 0. 横切基础层

### 应用入口与总装

- `src/main.tsx`：React 渲染进程入口。
- `src/App.tsx`：应用页面、标签页和各业务子系统的前端总装。
- `src/types.ts`：跨业务共享的配置、项目、媒体、组件和任务类型。
- `src/env.d.ts`：渲染进程 Electron API 类型入口。
- `src/index.css`：全局样式与基础控件样式。
- `electron/main.cjs`：Electron 主进程、服务实例和 IPC 模块总装。
- `electron/preload.cjs`：主进程能力向渲染进程暴露的安全桥接。
- `electron/security-policy.cjs`：窗口、导航、IPC 和外部链接安全策略。
- `electron/infrastructure/internal-workspace-path.cjs`：内部工作区路径规则。
- `electron/infrastructure/process-termination.cjs`：跨平台进程终止基础能力。

### 跨域契约与事件

- `src/contracts/domain-events.ts`
- `electron/contracts/domain-events.cjs`
- `electron/contracts/domain-ownership.cjs`
- `electron/services/event-bus.cjs`
- `electron/services/domain-command-journal.cjs`

### Python 公共协议

- `python/event_protocol.py`
- `python/database_error_codes.py`
- `python/tools.py`
- `python/compatibility/__init__.py`
- `python/compatibility/registry.py`

## 1. 应用外壳与用户配置系统

职责：窗口框架、首页、标签页、全局搜索、设置、隐私、法律文件、通知、反馈、更新和遥测。

### 渲染层

- `src/features/app/AppChrome.tsx`
- `src/features/app/AppErrorBoundary.tsx`
- `src/features/app/AppShellLayout.tsx`
- `src/features/app/DomainHealthBanner.tsx`
- `src/features/app/app-config.ts`
- `src/features/app/app-shell-layout-model.ts`
- `src/features/app/renderer-error-notice-model.ts`
- `src/features/app/toast-view-contract.ts`
- `src/features/app/top-toast-notice-model.ts`
- `src/features/app/top-toast-tone-model.ts`
- `src/features/app/user-facing-notice-model.ts`
- `src/features/app/useFolderTabNavigation.ts`
- `src/features/app/useRendererErrorReporting.ts`
- `src/features/app/useTitlebarTabOrder.ts`
- `src/features/app/useTopToastStack.tsx`
- `src/features/app/useUserFacingToast.ts`
- `src/features/app/useWorkspaceTabs.ts`
- `src/features/app/workspace-tab-model.ts`
- `src/features/search/SearchAllPage.tsx`
- `src/features/settings/SettingsFeature.tsx`
- `src/features/settings/UsagePreferencesOnboarding.tsx`
- `src/features/settings/restored-workspace-config.ts`
- `src/features/settings/component-settings-page-model.ts`
- `src/components/AppDialogProvider.tsx`
- `src/components/LayerProvider.tsx`
- `src/components/PanelSwitch.tsx`
- `src/components/ProgressBar.tsx`
- `src/components/host-layer-state.ts`
- `src/components/toast-stack-reflow.ts`
- `src/toast-view.tsx`
- `src/utils/privacyConsent.ts`
- `src/licenses/modelLicenses.ts`
- `src/licenses/softwareLicenses.ts`

### Electron 主进程

- `electron/modules/system-ipc.cjs`
- `electron/cloud-config.cjs`
- `electron/privacy-service.cjs`
- `electron/toast-view-preload.cjs`
- `electron/services/config-mutation-service.cjs`
- `electron/services/domain-health-service.cjs`
- `electron/services/telemetry-service.cjs`
- `electron/services/toast-view-manager.cjs`
- `electron/services/electron-smoke-probe.cjs`

### 法律发布材料与发布验收

- `docs/legal/DATA_RETENTION_AND_RIGHTS_RUNBOOK_TEMPLATE.md`
- `docs/legal/PIPIA_TEMPLATE.md`
- `docs/legal/README.md`
- `docs/legal/RELEASE_APPROVAL_TEMPLATE.json`
- `docs/legal/RELEASE_EVIDENCE_GUIDE.md`
- `docs/legal/THIRD_PARTY_DISTRIBUTION_EVIDENCE.md`
- `package.json`（法律证据结构与发布严格门禁命令）
- `scripts/check-project.cjs`（默认结构检查与 `--release-ready` 严格模式）
- `scripts/generate-release-json.cjs`
- `scripts/publish-release.cjs`
- `scripts/test-legal-release-evidence.cjs`

### 隐私行为验收

- `scripts/test-privacy-gate-contract.cjs`
- `scripts/test-privacy-revoke-telemetry.cjs`

### 云端遥测

- `services/cloudbase/telemetry-function/index.js`
- `services/cloudbase/telemetry-function/retention-policy.js`
- `services/cloudbase/telemetry-function/admin/app.js`
- `services/cloudbase/telemetry-function/admin/index.html`
- `services/cloudbase/telemetry-function/admin/styles.css`

### 云端遥测发布与行为验收

- `scripts/package-cloudbase-function.py`
- `scripts/test-cloudbase-function-package.cjs`
- `scripts/test-cloudbase-function-package.py`
- `services/cloudbase/telemetry-function/package.json`
- `docs/CLOUDBASE_ANALYTICS_GUIDE.md`
- `services/cloudbase/telemetry-function/test/logic.test.mjs`
- `services/cloudbase/telemetry-function/test/privacy-database-integration.test.mjs`
- `services/cloudbase/telemetry-function/test/privacy-operations.test.mjs`
- `services/cloudbase/telemetry-function/test/release-blockers.test.mjs`

## 2. 工作区与项目管理系统

职责：工作区目录、项目目录、项目分类、文件浏览、搜索、选择、拖放、复制移动、重命名、回收站、快捷方式和外部路径。

### 渲染层

- `src/components/ProjectNavigator.tsx`
- `src/features/file-browser/browser-context.ts`
- `src/features/file-operation-identity-model.ts`
- `src/features/metadata/metadata-labels.ts`
- `src/features/metadata/metadata-pane-model.ts`
- `src/features/workspace/ProjectWorkspace.tsx`
- `src/features/workspace/ProjectWorkspaceLayout.tsx`
- `src/features/workspace/ProjectToolModal.tsx`
- `src/features/workspace/FileMetadataPane.tsx`
- `src/features/workspace/PhotoshopIcon.tsx`
- `src/features/workspace/directory-preview-cache-model.ts`
- `src/features/workspace/file-entry-interaction-model.ts`
- `src/features/workspace/file-entry-sort-model.ts`
- `src/features/workspace/file-operation-notification-model.ts`
- `src/features/workspace/file-operation-state-model.ts`
- `src/features/workspace/folder-alphabet-filter-model.ts`
- `src/features/workspace/folder-cover-media-model.ts`
- `src/features/workspace/marquee-auto-scroll.ts`
- `src/features/workspace/marquee-selection-model.ts`
- `src/features/workspace/multi-selection-metadata-model.ts`
- `src/features/workspace/native-file-drag-session-model.ts`
- `src/features/workspace/project-panel-lifecycle.ts`
- `src/features/workspace/project-toolbar-overflow-model.ts`
- `src/features/workspace/project-workspace-layout-model.ts`
- `src/features/workspace/project-workspace-lifecycle.ts`
- `src/features/workspace/project-workspace-media-metadata.ts`
- `src/features/workspace/shortcut-preview-state-model.ts`
- `src/features/workspace/useProjectFileSelection.ts`
- `src/features/workspace/useProjectThumbnail.ts`
- `src/features/workspace/useRecentFilesAutoLoad.ts`
- `src/platform/project-workspace-client.ts`
- `src/platform/workspace-catalog-client.ts`
- `src/contracts/project-workspace-api.ts`
- `src/utils/recycleBinFailure.ts`

### Electron IPC 与领域入口

- `electron/modules/workspace-ipc.cjs`
- `electron/modules/files-ipc.cjs`
- `electron/modules/selection-ipc.cjs`
- `electron/modules/workspace/deleted-project-cleanup.cjs`
- `electron/modules/workspace/entry-utility-ipc.cjs`
- `electron/modules/workspace/file-list-contract.cjs`
- `electron/modules/workspace/managed-external-watcher.cjs`
- `electron/modules/workspace/project-date.cjs`
- `electron/modules/workspace/storage-policy.cjs`
- `electron/domains/workspace/public.cjs`
- `electron/domains/file-operations/public.cjs`
- `electron/contracts/project-content-commands.cjs`

### Electron 服务与仓储

- `electron/repositories/workspace-repository.cjs`
- `electron/services/workspace-service.cjs`
- `electron/services/workspace-reconcile-task.cjs`
- `electron/services/file-system-service.cjs`
- `electron/services/file-transfer-service.cjs`
- `electron/services/file-clipboard-service.cjs`
- `electron/services/file-publication-service.cjs`
- `electron/services/file-identity-service.cjs`
- `electron/services/file-root-watcher-service.cjs`
- `electron/services/project-virtual-path-service.cjs`
- `electron/services/protected-project-folder.cjs`
- `electron/services/recycle-bin-service.cjs`
- `electron/services/native-file-drag-service.cjs`
- `electron/services/selection-service.cjs`
- `electron/services/shell-new-service.cjs`
- `electron/services/watch-change-filter.cjs`

### 原生文件系统辅助进程

- `electron/native/FileClipboardService.cs`
- `electron/native/FilePublicationService.cs`
- `electron/native/FilePublicationServicePosix.c`
- `electron/native/RecycleBinService.cs`
- `electron/native/RecycleBinService.manifest`
- `scripts/build-recycle-bin-service.cjs`
- `scripts/test-file-transfer.cjs`
- `scripts/test-recycle-bin-service.cjs`

## 3. 媒体资产管理与预览系统

职责：图片、RAW 和视频识别，缩略图、缓存、元数据、评分、预览、播放、字幕、截图、裁剪和剪辑。

### 渲染层与播放契约

- `src/components/AdvancedVideoPlayer.tsx`
- `src/components/InteractiveCropEditor.tsx`
- `src/components/MediaThumbnail.tsx`
- `src/components/VideoHoverThumbnail.tsx`
- `src/components/video-subtitle-memory.ts`
- `src/features/app/video-player-settings.ts`
- `src/platform/video-playback/playback-session.ts`
- `src/contracts/video-playback.ts`
- `src/contracts/video-shortcuts.ts`
- `src/contracts/playback-errors.ts`
- `src/compatibility/legacy-video-playback-settings.ts`

### Electron IPC、契约与领域入口

- `electron/modules/media-ipc.cjs`
- `electron/modules/media-rating-ipc.cjs`
- `electron/modules/video-playback-ipc.cjs`
- `electron/modules/workspace/video-timeline-ipc.cjs`
- `electron/domains/media/public.cjs`
- `electron/contracts/media-sync-limits.cjs`
- `electron/contracts/media-playback-backend-contract.cjs`
- `electron/contracts/media-playback-backend-v1.cjs`
- `electron/contracts/playback-diagnostics.cjs`
- `electron/contracts/playback-errors.cjs`

### Electron 媒体服务

- `electron/repositories/media-repository.cjs`
- `electron/services/media-service.cjs`
- `electron/services/media-access-service.cjs`
- `electron/services/media-response-service.cjs`
- `electron/services/media-input-session-service.cjs`
- `electron/services/media-cache-namespace.cjs`
- `electron/services/media-rating-service.cjs`
- `electron/services/media-tracking-scan-scheduler.cjs`
- `electron/services/thumbnail-service.cjs`
- `electron/services/thumbnail-coordinator.cjs`
- `electron/services/image-thumbnail-runtime.cjs`
- `electron/services/raw-orientation-service.cjs`
- `electron/services/video-playback-broker.cjs`
- `electron/services/video-playback-process-service.cjs`
- `electron/services/media-playback-process-adapter.cjs`
- `electron/services/native-video-surface-service.cjs`
- `electron/services/video-display-output-service.cjs`
- `electron/services/playback-capture-service.cjs`
- `electron/services/playback-subtitle-input-service.cjs`
- `electron/services/video-trim-commit-service.cjs`
- `electron/thumbnail-pipeline.cjs`

### 原生与 Python 媒体能力

- `electron/native/ShellThumbnailCache.cs`
- `electron/native/VideoSurfaceHost.cs`
- `python/thumbnail_db.py`
- `python/thumbnail_image.py`
- `python/raw_decoder.py`

## 4. 导入、整理与媒体工具系统

职责：SD 卡导入、素材分类、花絮导入、图片转换、主图提取、Office 图片提取、文件名选片、灵感库和视频工具入口。

### 渲染层

- `src/features/tools/ToolViews.tsx`
- `src/features/tools/filename-selection-model.ts`
- `src/features/tools/import-completion-model.ts`
- `src/features/tools/sd-startup-import-model.ts`
- `src/features/tools/startup-sd-auto-import-model.ts`
- `src/features/tools/storage-device-inventory-model.ts`
- `src/features/tools/tool-source-selection-model.ts`
- `src/features/tools/use-startup-sd-auto-import.ts`
- `src/features/tools/use-storage-device-inventory.ts`
- `src/features/tools/video-transcode-model.ts`
- `src/components/ImportSourceControls.tsx`
- `src/components/SourcePathPicker.tsx`
- `src/components/source-path-picker-model.ts`
- `src/features/inspiration/InspirationLibrary.tsx`
- `src/features/workspace/office-extraction-result-model.ts`

### Electron 导入与任务编排

- `electron/modules/broll-import.cjs`
- `electron/modules/workspace/import-receipt-service.cjs`
- `electron/modules/workspace/import-recovery.cjs`
- `electron/modules/workspace/sd-import-media-scan.cjs`
- `electron/services/storage-device-service.cjs`
- `electron/services/project-file-task-service.cjs`
- `electron/services/json-command-runner.cjs`
- `electron/services/python-environment-service.cjs`
- `electron/services/python-json-protocol.cjs`
- `electron/services/rename-runtime-model.cjs`

### Python 工具与算法

- `python/classify.py`
- `python/catch.py`
- `python/rename.py`
- `python/research.py`
- `python/screenshot_main_image.py`
- `python/png_to_jpg.py`
- `python/office_media_extract.py`
- `python/inspiration_tools.py`

## 5. 版本与后期工作流系统

职责：进度文件夹、版本树、父子版本、补充关系、版本跟踪、内容比较、版本修复和选择结果兼容。

### 渲染层

- `src/components/VersionManager.tsx`
- `src/components/ProjectVersionTree.tsx`
- `src/components/ImageComparisonView.tsx`
- `src/features/workspace/progress-tree-model.ts`
- `src/features/versioning/public.ts`
- `src/features/versioning/FolderMarkPanel.tsx`
- `src/features/versioning/LegacySelectionRepairNotice.tsx`
- `src/features/versioning/ProgressPairPreview.tsx`
- `src/features/versioning/TrackingConfirmationPanel.tsx`
- `src/features/versioning/VersionProgressPanel.tsx`
- `src/features/versioning/folder-mark-model.ts`
- `src/features/versioning/progress-relation-mutation-queue.ts`
- `src/features/versioning/project-version-tree-entry-model.ts`
- `src/features/versioning/tracking-confirmation-model.ts`
- `src/features/versioning/use-version-tree-canvas.ts`
- `src/features/versioning/version-manager-model.ts`
- `src/features/versioning/version-tree-canvas-model.ts`
- `src/features/versioning/version-tree-edge-model.ts`
- `src/features/versioning/version-tree-layout-model.ts`
- `src/features/versioning/versioning-v2-model.ts`

### Electron 版本服务

- `electron/modules/versions-ipc.cjs`
- `electron/modules/version-tracking-ipc.cjs`
- `electron/domains/versioning/public.cjs`
- `electron/services/version-service.cjs`
- `electron/services/version-stale-detection-service.cjs`

版本、进度关系和跟踪结果的持久化由第 6 子系统中的 `workspace_db.py`、领域数据库和仓储共同提供。

## 6. 数据、后台任务与可靠性系统

职责：SQLite 数据域、迁移、后台任务、操作日志、备份恢复、归档、崩溃恢复、维护、进程监管、磁盘与缓存统计。

### 后台任务渲染层

- `src/features/background-tasks/TaskCenter.tsx`
- `src/features/background-tasks/BackgroundTaskIndicator.tsx`
- `src/features/background-tasks/FileTransferToast.tsx`
- `src/features/background-tasks/background-task-stream-model.ts`
- `src/features/background-tasks/panel-task-session-model.ts`
- `src/features/background-tasks/task-toast-model.ts`
- `src/components/TaskStatus.tsx`
- `src/components/useTaskPresentation.ts`

### Electron IPC 与仓储

- `electron/modules/background-tasks-ipc.cjs`
- `electron/modules/backup-ipc.cjs`
- `electron/modules/archive-ipc.cjs`
- `electron/modules/storage-usage-ipc.cjs`
- `electron/modules/workspace/workspace-maintenance.cjs`
- `electron/repositories/database-client.cjs`
- `electron/repositories/coordinated-database-client.cjs`
- `electron/repositories/operations-repository.cjs`
- `electron/repositories/workspace-database-operation-policy.cjs`

### Electron 可靠性服务

- `electron/services/background-task-service.cjs`
- `electron/services/background-task-migrations.cjs`
- `electron/services/background-task-policies.cjs`
- `electron/services/background-task-policy-versions.cjs`
- `electron/services/backup-service.cjs`
- `electron/services/archive-service.cjs`
- `electron/services/storage-usage-service.cjs`
- `electron/services/workspace-sqlite-coordinator.cjs`
- `electron/services/workspace-storage-key-service.cjs`
- `electron/services/detached-background-operation.cjs`
- `electron/services/dirty-coalescing-runner.cjs`
- `electron/services/keyed-admission-queue.cjs`
- `electron/services/sliced-maintenance-runner.cjs`
- `electron/services/process-supervisor.cjs`
- `electron/services/credential-service.cjs`
- `electron/services/retired-cache-service.cjs`
- `electron/scripts/windows-credential.ps1`

### Python 数据层

- `python/workspace_db.py`
- `python/workspace_db_domains.py`
- `python/workspace_db_migrations.py`
- `python/workspace_domain_storage.py`
- `python/operations_db.py`
- `python/backup_db.py`
- `python/domain_recovery.py`

## 7. 组件／插件平台系统

职责：组件发现、安装、完整性校验、沙箱页面、受监管服务、Host API、能力授权、项目读写、设置、通知、网络、密钥和数据迁移。

### 渲染层

- `src/components/ComponentIcon.tsx`
- `src/features/components/ComponentContributionDock.tsx`
- `src/features/components/ComponentDeclarativeSettingsSurface.tsx`
- `src/features/components/ComponentPageSurface.tsx`
- `src/features/components/ComponentSettingsPageSurface.tsx`
- `src/features/components/ComponentToolPanelSurface.tsx`
- `src/features/components/component-availability-model.ts`
- `src/features/components/component-command-palette-model.ts`
- `src/features/components/component-contribution-scope-model.ts`
- `src/features/components/component-page-model.ts`
- `src/features/components/useComponentPages.ts`

### Electron 组件宿主与契约

- `electron/component-development.cjs`
- `electron/component-host-contract.cjs`
- `electron/component-integrity.cjs`
- `electron/component-preload.cjs`
- `electron/component-registry.cjs`
- `electron/component-rpc-contract.cjs`
- `electron/modules/component-host-ipc.cjs`
- `electron/modules/component-icon-protocol.cjs`
- `electron/plugins/plugin-catalog.cjs`
- `electron/contracts/component-host-errors.cjs`
- `electron/contracts/component-notification-renderer-event.cjs`
- `electron/contracts/component-settings-form-contract.cjs`

### Electron 组件服务

- `electron/services/plugin-service.cjs`
- `electron/services/component-capability-broker.cjs`
- `electron/services/component-host-capability-runtime.cjs`
- `electron/services/component-lifecycle-service.cjs`
- `electron/services/component-network-service.cjs`
- `electron/services/component-notification-service.cjs`
- `electron/services/component-project-capabilities.cjs`
- `electron/services/component-project-read-capabilities.cjs`
- `electron/services/component-project-write-capabilities.cjs`
- `electron/services/component-secrets-service.cjs`
- `electron/services/component-service-manager.cjs`
- `electron/services/component-status-refresh-policy.cjs`
- `electron/services/component-storage-adoption.cjs`
- `electron/services/component-view-manager.cjs`
- `electron/compatibility/component-cache-paths.cjs`
- `electron/compatibility/component-data-adoption-policy.cjs`
- `electron/compatibility/component-output-v1-adoption.cjs`

### 对外 Component SDK

- `component-sdk/index.d.ts`
- `component-sdk/index.js`
- `component-sdk/service.cjs`
- `component-sdk/service.d.ts`
- `component-sdk/ui.css`

## 8. 可选专业扩展系统

每个扩展都是独立部署单元，但统一运行在第 7 子系统的组件宿主内。

### 8.1 团片协作

#### 服务与算法

- `extensions/team-retouch/service.cjs`
- `extensions/team-retouch/team_retouch.py`
- `extensions/team-retouch/identity_engine.py`
- `extensions/team-retouch/patch_merge.py`
- `extensions/team-retouch/advanced_bridge.py`
- `extensions/team-retouch/advanced/pairdetr_service.py`
- `extensions/team-retouch/advanced/sam2_service.py`
- `extensions/team-retouch/workflow-artifact.cjs`
- `extensions/team-retouch/workflow-generation.cjs`
- `extensions/team-retouch/workflow-manifest.cjs`

#### 扩展界面

- `extensions/team-retouch/renderer/index.html`
- `extensions/team-retouch/renderer/settings.html`
- `extensions/team-retouch/renderer/src/legacy-main.tsx`
- `extensions/team-retouch/renderer/src/settings-main.tsx`
- `extensions/team-retouch/renderer/src/sdk.ts`
- `extensions/team-retouch/renderer/src/interaction-model.ts`
- `extensions/team-retouch/renderer/src/history-toast-model.ts`
- `extensions/team-retouch/renderer/src/task-terminal-notice-model.ts`
- `extensions/team-retouch/renderer/src/team-settings-content.tsx`
- `extensions/team-retouch/renderer/src/team-settings-model.ts`
- `extensions/team-retouch/renderer/src/workflow-schedule.ts`
- `extensions/team-retouch/renderer/src/legacy/IdentityPickerPanel.tsx`
- `extensions/team-retouch/renderer/src/legacy/ImageComparisonView.tsx`
- `extensions/team-retouch/renderer/src/legacy/PersonIdentityManager.tsx`
- `extensions/team-retouch/renderer/src/legacy/TeamRetouchBrand.tsx`
- `extensions/team-retouch/renderer/src/legacy/TeamRetouchManager.tsx`
- `extensions/team-retouch/renderer/src/legacy/TeamRetouchOutputProgress.tsx`
- `extensions/team-retouch/renderer/src/legacy/TeamRetouchSteps.tsx`
- `extensions/team-retouch/renderer/src/legacy/TeamWorkflowHeader.tsx`
- `extensions/team-retouch/renderer/src/legacy/useTeamOutputProgress.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-advanced-status-model.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-api.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-dialog-context.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-dialog.tsx`
- `extensions/team-retouch/renderer/src/legacy/legacy-entry-scope.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-history-load-model.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-layer.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-media-preview-model.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-media-scheduler.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-migration-progress-model.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-privacy.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-progress-result-model.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-progress-scope.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-types.ts`
- `extensions/team-retouch/renderer/src/legacy/legacy-workspace-seed-model.ts`
- `extensions/team-retouch/renderer/src/host-api-ui.css`
- `extensions/team-retouch/renderer/src/legacy-style.css`
- `extensions/team-retouch/renderer/src/settings-style.css`
- `extensions/team-retouch/renderer/src/tailwind.css`

#### 兼容与恢复

- `extensions/team-retouch/compatibility/project-folder-policy.cjs`
- `extensions/team-retouch/compatibility/storage-restore.cjs`
- `extensions/team-retouch/compatibility/python/compatibility/__init__.py`
- `extensions/team-retouch/compatibility/python/compatibility/registry.py`
- `extensions/team-retouch/compatibility/python/team_retouch_v1/__init__.py`
- `extensions/team-retouch/compatibility/python/team_retouch_v1/backup.py`
- `extensions/team-retouch/compatibility/python/team_retouch_v1/database_tool.py`
- `extensions/team-retouch/compatibility/python/team_retouch_v1/recovery.py`
- `extensions/team-retouch/compatibility/python/team_retouch_v1/storage.py`
- `extensions/team-retouch/compatibility/python/team_retouch_v1/workspace.py`

### 8.2 视频处理

- `extensions/video-tools/service.cjs`
- `extensions/video-tools/runtime/worker.py`
- `extensions/video-tools/runtime/ffmpeg_transcode.py`
- `extensions/video-tools/runtime/ffmpeg_utils.py`
- `extensions/video-tools/runtime/cut_video.py`
- `extensions/video-tools/runtime/video_preview.py`
- `extensions/video-tools/ui/app.js`
- `extensions/video-tools/ui/transcode.html`
- `extensions/video-tools/ui/split.html`
- `extensions/video-tools/ui/style.css`

### 8.3 高级视频播放

- `extensions/video-playback-mpv/src/AdvancedVideoDecoder.cs`
- `extensions/video-playback-mpv/protocol/index.d.ts`

该扩展的 `media-runtime/` 和 `scripts/` 主要是 libmpv/FFmpeg 的可审计构建、校验、签名和打包链路，不属于运行时业务代码。

### 8.4 视频转文字

- `extensions/video-transcription/service.cjs`
- `extensions/video-transcription/core.cjs`
- `extensions/video-transcription/engine.py`
- `extensions/video-transcription/ui/index.html`
- `extensions/video-transcription/ui/settings.html`
- `extensions/video-transcription/ui/app.js`
- `extensions/video-transcription/ui/settings.js`
- `extensions/video-transcription/ui/settings-save-model.js`
- `extensions/video-transcription/ui/explicit-start-model.js`
- `extensions/video-transcription/ui/selection-preview-model.js`
- `extensions/video-transcription/ui/transcript-browser-model.js`
- `extensions/video-transcription/ui/refresh-coordinator.js`
- `extensions/video-transcription/ui/host-api-ui.css`
- `extensions/video-transcription/ui/style.css`

## 测试文件归属规则

自动化测试主要集中在 `scripts/test-*` 和 `extensions/*/tests/`，可按下面的文件名前缀映射回业务子系统：

| 子系统 | 测试文件前缀或关键词 |
|---|---|
| 应用外壳与配置 | `test-workspace-tab-*`、`test-titlebar-*`、`test-toast-*`、`test-privacy-*`、`test-telemetry-*`、`test-settings-*`、`test-renderer-error-*` |
| 工作区与项目 | `test-file-*`、`test-filesystem-*`、`test-recycle-bin-*`、`test-selection-*`、`test-project-workspace-*`、`test-project-virtual-path-*`、`test-marquee-*`、`test-native-file-drag-*` |
| 媒体资产与预览 | `test-thumbnail-*`、`test-media-*`、`test-raw-*`、`test-video-playback-*`、`test-advanced-video-*`、`test-video-trim-*`、`test-image-comparison-*` |
| 导入与工具 | `test-classify-*`、`test-catch-*`、`test-sd-*`、`test-source-path-*`、`test-tool-source-*`、`test-office-*`、`test-research-*`、`test-screenshot-*`、`test-inspiration-*` |
| 版本与工作流 | `test-version-*`、`test-versioning-*`、`test-progress-*`、`test-media-workflow-*` |
| 数据与可靠性 | `test-background-task-*`、`test-backup-*`、`test-archive-*`、`test-database-*`、`test-domain-*`、`test-operations-*`、`test-process-supervisor-*`、`test-storage-usage-*`、`test-workspace-sqlite-*` |
| 组件平台 | `test-component-*` |
| 专业扩展 | `extensions/team-retouch/tests/*`、`extensions/video-tools/tests/*`、`extensions/video-playback-mpv/tests/*`、`extensions/video-transcription/tests/*` |

## 维护边界建议

- 新增用户界面时，优先放到对应的 `src/features/<domain>/`，不要继续扩大 `App.tsx`。
- 新增主进程能力时，业务入口放 `electron/modules/*-ipc.cjs`，领域逻辑放 `electron/services/` 或 `electron/domains/`，不要继续扩大 `electron/main.cjs`。
- 数据表、迁移和恢复应同时明确归属到工作区、媒体、版本或操作日志数据域。
- 插件专属业务必须留在 `extensions/<component-id>/`，主程序只提供稳定 Host API，不反向依赖插件实现。
- 同时影响多个子系统的文件应优先抽出契约或服务，而不是继续堆入 `ProjectWorkspace.tsx` 或 `workspace_db.py`。
