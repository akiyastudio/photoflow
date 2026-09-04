# 照片流法律与隐私文件

版本：2026-09-01

适用版本：照片流 26.8.31 公测版

本目录中的对外 HTML 文件会随桌面安装包分发，并可在“设置 → 隐私与数据”中打开。证据模板和内部记录不属于对外条款，也不能代替用户或律师的审核、批准与签署。

## 对外文件

- `INSTALLER_TERMS.html`：用户协议与隐私政策的安装条款合并页面
- `INSTALLER_TERMS.txt`：由上述 HTML 正文自动生成、供 NSIS 原生许可控件显示的 UTF-8 文本副本
- `PRIVACY_POLICY.html`：隐私政策
- `USER_AGREEMENT.html`：用户协议及公测条款
- `FACE_RECOGNITION_RULES.html`：人脸信息处理规则
- `PERSONAL_INFORMATION_LIST.html`：个人信息处理清单
- `THIRD_PARTY_SERVICES.html`：第三方服务清单
- `PERMISSIONS.html`：权限与本地文件访问说明
- `CHILDREN_PRIVACY.html`：儿童个人信息保护规则
- `CUSTOMER_DATA_PROCESSING_TERMS.html`：影楼、工作室客户数据条款
- `OPEN_SOURCE_NOTICES.html`：开源软件与模型许可说明

## 发布证据模板

- [发布证据填写与验收指南](RELEASE_EVIDENCE_GUIDE.md)
- [人脸身份识别个人信息保护影响评估模板](PIPIA_TEMPLATE.md)
- [数据保存、清理与个人权利请求运行手册模板](DATA_RETENTION_AND_RIGHTS_RUNBOOK_TEMPLATE.md)
- [第三方发行证据核对表](THIRD_PARTY_DISTRIBUTION_EVIDENCE.md)
- [非敏感发布批准索引模板](RELEASE_APPROVAL_TEMPLATE.json)

模板中的 `[待填写]`、`[待核验]` 和未签署栏均表示证据尚未闭环。不得因为模板已创建而将发布阻断项标记为完成。

## 发布批准严格门禁

证据模板应保留“待填写 / 待核验”占位标记作为可复用指南，门禁不会以“清空模板占位符”判定可发布。五项阻断证据和三类批准都已在受控证据库完成后，复制 `RELEASE_APPROVAL_TEMPLATE.json` 为 `RELEASE_APPROVAL.json`，仅填写版本、被构建源码的 `buildSourceCommit`、最终安装包 SHA-256、稳定 `DELIVERY-MANIFEST.json` SHA-256、批准角色以及证据 ID / SHA-256 / 日期索引。批准索引应位于从 `buildSourceCommit` 派生的后续独立审批提交中，不要求审批提交等于被构建提交。

签名原件、证照、身份材料、管理 Token、密钥和控制台导出必须留在可审计的受控证据库；Git 中的 `RELEASE_APPROVAL.json` 只是非敏感索引。最终门禁会把批准索引同时绑定到不可变 staging 中的 Setup、完整交付清单及其 Git commit，再按清单重新哈希所有组件；未签名的构建回执不能代替这项人工批准。

## 发布阻断项

正式向不特定用户发布前，必须补齐并核验：

1. 成都市金牛区拾玖寻铃摄影工作室的注册地址/常用办公地址。填写和验收见[发布证据填写与验收指南](RELEASE_EVIDENCE_GUIDE.md#1-经营者地址)。
2. 个人信息权利请求处理人和稳定联系渠道。填写和验收见[发布证据填写与验收指南](RELEASE_EVIDENCE_GUIDE.md#2-个人信息权利请求责任人和渠道)。
3. 服务器实际部署地域、数据库保存及删除任务。填写和演练见[数据保存、清理与个人权利请求运行手册模板](DATA_RETENTION_AND_RIGHTS_RUNBOOK_TEMPLATE.md)。
4. 人脸信息个人信息保护影响评估的签署人和批准记录。填写和签署见[人脸身份识别个人信息保护影响评估模板](PIPIA_TEMPLATE.md)。
5. 第三方软件完整许可证、FFmpeg 对应源码及构建参数。核对和归档见[第三方发行证据核对表](THIRD_PARTY_DISTRIBUTION_EVIDENCE.md)。
