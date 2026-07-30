# PhotoFlow 接入腾讯云 CloudBase：统计、更新与崩溃上报

这份说明对应当前仓库中的 Electron 客户端和
`cloudbase/telemetry-function` HTTP 云函数。安装包放在你自己的网盘，
云函数只负责统计、崩溃报告和返回网盘下载链接。完成后可得到：

- 激活量：首次同意统计并启动软件的匿名安装数
- 留存：D1、D7、D30 再次启动比例
- 活跃：每日活跃安装数和指定时间窗口内活跃安装数
- 高频功能：各页面/功能入口的打开次数
- 创建项目次数
- 导入数量区间：`1-20`、`21-100`、`101-500`、`501-2000`、`2001+`
- 崩溃报告：进程类型、错误消息、堆栈、脱敏日志尾部
- 更新检查：按系统、渠道读取最新版本和下载地址

## 0. 先理解安全边界

桌面安装包里的任何内容都可能被用户读到，所以不要把腾讯云
`SecretId`、`SecretKey`、CloudBase 服务端 API Key 或后台管理 Token
写入 Electron 项目。

正确链路是：

```text
PhotoFlow 客户端
  └─ HTTPS ─> CloudBase HTTP 云函数
                 ├─ analytics_events（仅云函数可写）
                 ├─ crash_reports（仅云函数可写）
                 └─ app_releases（保存版本号和网盘链接）

网盘
  └─ PhotoFlow 安装包
```

客户端只保存随机安装 ID，不上传照片、文件名、完整路径和项目名称。
内测版中使用统计与崩溃上报默认开启，两个开关仅用于展示状态并暂时锁定，界面明确提示“内测版暂时无法关闭”。

CloudBase HTTP 云函数可以直接上传本地 ZIP 包，按请求启动、执行并自动回收；
文档型数据库可直接创建 JSON 集合。

- [CloudBase 云函数](https://docs.cloudbase.net/cloud-function/introduce)
- [Node.js HTTP 云函数快速开始](https://docs.cloudbase.net/cloud-function/quickstart/httpfunc/nodejs)
- [控制台部署云函数](https://docs.cloudbase.net/cloud-function/manage)
- [文档型数据库](https://docs.cloudbase.net/database/introduce)

## 1. 创建数据库集合

以下代码使用的是 CloudBase「文档型数据库」。如果你的环境只有
PostgreSQL，请先在 CloudBase 环境中启用文档型数据库，或把服务端数据层
改成 PG API 后再部署。

进入：

```text
腾讯云 CloudBase 控制台
→ 选择你的环境
→ 文档型数据库
→ 新建集合
```

依次创建三个集合：

```text
analytics_events
crash_reports
app_releases
user_feedback
```

权限全部设为「仅管理端可读写」或等价的私有权限。不要开启「所有用户可读写」。
客户端不会直接访问数据库，而是访问 HTTP 云函数。

建议索引：

| 集合 | 索引字段 | 顺序 |
|---|---|---|
| `analytics_events` | `clientTime` | 降序 |
| `analytics_events` | `eventName`, `clientTime` | 升序、降序 |
| `crash_reports` | `receivedAt` | 降序 |
| `crash_reports` | `status`, `receivedAt` | 升序、降序 |
| `app_releases` | `platform`, `channel`, `published`, `versionCode` | 升序、升序、升序、降序 |
| `user_feedback` | `receivedAt` | 降序 |

CloudBase 的索引入口和组合索引说明见
[索引管理](https://docs.cloudbase.net/database/data-index)。

## 2. 准备服务端环境变量

HTTP 云函数需要三个环境变量：

```text
CLOUDBASE_ENV_ID=你的 CloudBase 环境 ID
PHOTOFLOW_INGEST_KEY=photoflow-desktop-v1
PHOTOFLOW_ADMIN_TOKEN=只放服务端的长随机字符串
```

`PHOTOFLOW_INGEST_KEY` 会随桌面软件发布，只用于过滤无关请求，不是真正的
秘密。`PHOTOFLOW_ADMIN_TOKEN` 才是查看统计汇总的密码，绝不能写入客户端。

在 PowerShell 里生成管理 Token：

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToHexString($bytes).ToLower()
```

复制输出值，填到云函数环境变量中。不要把它提交到 Git。

## 3. 上传 HTTP 云函数

可以直接上传的 ZIP 已生成在：

```text
output/photoflow-cloud-function-dashboard-cloudbase.zip
```

控制台操作：

1. 左侧进入「云函数 → 函数管理」。
2. 点击「新建云函数」。
3. 函数类型选择「HTTP 云函数」。
4. 函数名称填写 `photoflow-api`。
5. 运行时选择 `Node.js 20`；如果没有则选择 `Node.js 18`。
6. 部署方式选择「本地上传」或「上传 ZIP」。
7. 上传 `output/photoflow-cloud-function-dashboard-cloudbase.zip`。
8. 端口使用 HTTP 云函数固定端口 `9000`。
9. 内存选择 `256 MB` 或 `512 MB`，超时设为 `10 秒`。
10. 添加上一节的三个环境变量。
11. 点击创建/部署，并等待依赖安装完成。

ZIP 根目录已经包含 `index.js`、`package.json`、`package-lock.json` 和
`scf_bootstrap`，没有多包一层文件夹。CloudBase 会根据 `package.json`
安装依赖。

## 4. 配置 HTTP 网关

在 2026 年的 CloudBase 控制台中，原「HTTP 访问服务」已更名为
「HTTP 网关」。

1. 打开「HTTP 网关」（旧控制台可能叫「HTTP 访问」）。
2. 新建域名关联资源，资源类型选择「云函数」。
3. 选择 `photoflow-api`，触发路径使用 `/`。
4. 开启「路径透传」，确保 `/v1/events` 等子路径可以到达函数。
5. 测试期先使用默认域名。

假设得到：

```text
https://example.ap-shanghai.app.tcloudbase.com
```

在 PowerShell 验证：

```powershell
Invoke-RestMethod "https://example.ap-shanghai.app.tcloudbase.com/health"
```

预期：

```json
{
  "ok": true,
  "service": "photoflow-telemetry-api"
}
```

## 5. 把 API 地址写入桌面软件

打开 `electron/cloud-config.cjs`，只改 `apiBaseUrl`：

```js
module.exports = {
  apiBaseUrl: 'https://example.ap-shanghai.app.tcloudbase.com',
  ingestKey: 'photoflow-desktop-v1',
  updateChannel: 'stable',
};
```

这里不能填写管理 Token 或腾讯云密钥。

## 6. 发布第一条更新记录

进入 `app_releases` 集合，新增一条文档。示例：

```json
{
  "_id": "win32-stable-26-7-29",
  "platform": "win32",
  "channel": "stable",
  "version": "26.7.30",
  "versionCode": 260729,
  "downloadUrl": "https://你的腾讯云域名/releases/26.7.30/照片流-Setup.exe",
  "sha256": "安装包的 SHA-256",
  "notes": "修复已知问题并提升稳定性。",
  "mandatory": false,
  "published": true,
  "publishedAt": "2026-07-29T00:00:00.000Z"
}
```

规则：

- Windows 的 `platform` 用 `win32`，macOS 用 `darwin`。
- `version` 与 `package.json` 的版本格式保持一致。
- `versionCode` 必须随版本递增，它只用于数据库排序。
- 安装包还没上传、下载链接还没验证时，必须设 `published: false`。
- `downloadUrl` 必须是 HTTPS。
- `sha256` 必须是安装包完整的 64 位 SHA-256。缺少任一字段时，即使 `published: true`，更新接口也不会发布这条记录。
- 开源源码归档和许可证资料继续按发行版本单独留存，但不写入 `app_releases` 数据库记录。
- PowerShell 计算安装包 SHA-256：

```powershell
Get-FileHash "C:\path\to\PhotoFlow-Setup.exe" -Algorithm SHA256
```

验证更新接口：

```powershell
Invoke-RestMethod "https://example.ap-shanghai.app.tcloudbase.com/v1/updates?platform=win32&channel=stable&currentVersion=26.7.30"
```

客户端仅通过配置的 CloudBase URL 读取这个接口。未配置腾讯云更新服务或接口不可用时，
更新检查会直接失败，不会请求其他更新服务。

## 7. 在软件里验证统计

本地启动：

```powershell
npm run electron:dev
```

然后：

1. 打开「设置 → 常规 → 隐私与使用统计」。
2. 开启「发送匿名使用统计」。
3. 开启「自动发送崩溃报告」。
4. 返回首页、打开项目、打开版本或团片页。
5. 新建一个测试项目。
6. 导入一批测试文件。
7. 等待最多 30 秒。
8. 在 CloudBase 数据库查看 `analytics_events`。

应能看到这些 `eventName`：

```text
session_start
feature_opened
feature_used
project_created
photos_imported
update_checked
```

`photos_imported.properties.count_bucket` 只保存数量区间，不保存精确照片列表。

客户端本地状态位于 Electron 的 `userData` 目录：

```text
telemetry-state.json
telemetry-queue.json
```

内测版会强制保持使用统计与崩溃上报开启；即使旧配置或手动修改的配置写入了
`false`，主进程读取和保存配置时也会迁移为开启状态。

## 8. 查看激活、留存和高频功能

统计汇总接口只接受服务端管理 Token。不要把这个 Token 放进网页前端或桌面
软件。

PowerShell：

```powershell
$adminToken = "第 2 步生成的 PHOTOFLOW_ADMIN_TOKEN"
$headers = @{ Authorization = "Bearer $adminToken" }
Invoke-RestMethod `
  "https://example.ap-shanghai.app.tcloudbase.com/v1/admin/metrics?days=30" `
  -Headers $headers
```

主要字段：

| 字段 | 含义 |
|---|---|
| `activationCount` | 时间窗口内首次出现的匿名安装数 |
| `activeInstallations` | 时间窗口内至少启动过一次的匿名安装数 |
| `dailyActive` | 每日活跃安装数 |
| `retention.d1/d7/d30` | 对应日期再次启动的 cohort、returned、rate |
| `highFrequencyFeatures` | 功能入口使用次数排行 |
| `importCountBuckets` | 导入数量区间分布 |
| `truncated` | 是否达到 50,000 条扫描上限 |

数据中心还会读取 `user_feedback`，展示周期内反馈总数、待处理数量及最近 30 条
问题与建议。反馈正文只在输入管理 Token 后返回，并以纯文本方式渲染。

这个汇总端点适合内测和早期产品。数据量接近 50,000 条时，应改成每日定时聚合，
把结果写入 `analytics_daily`，避免每次扫描原始事件。

## 9. 验证崩溃报告

不要为了测试而破坏生产代码。开发环境会主动跳过崩溃上报，避免 HMR 和 React
开发警告污染数据。需要端到端验证时，请使用独立的打包测试版本，并在测试完成后
将测试报告标为 `ignored`。

CloudBase 的 `crash_reports` 文档包含：

```text
processType
errorName
message
stack
logTail
appVersion
platform
fingerprint
status
```

`logTail` 只取最近的错误/警告行，并在客户端先替换本机路径、邮箱及常见
项目/文件字段。仍建议上线前人工检查你的应用日志格式，确保没有业务侧自定义的
敏感字段。

请使用管理端导出接口获取严格 UTF-8 JSON，不要使用可能产生非标准反斜杠转义的
数据库控制台逐行导出：

```powershell
$adminToken = "PHOTOFLOW_ADMIN_TOKEN 的值"
$headers = @{ Authorization = "Bearer $adminToken" }
Invoke-WebRequest `
  "https://example.ap-shanghai.app.tcloudbase.com/v1/admin/crashes-export?limit=10000" `
  -Headers $headers `
  -OutFile "photoflow-crashes.json"
```

处理崩溃时把 `status` 从 `new` 改为：

```text
investigating
fixed
ignored
```

## 10. 上线前检查清单

- 已发布隐私政策，写清收集字段、目的、保存期限、内测版暂时无法关闭的说明和联系渠道。
- 用户不同意统计时，不发送 `session_start` 或功能事件。
- 用户不同意崩溃上报时，日志只留本机。
- 数据库三个集合均不是公开读写。
- 客户端没有 `SecretId`、`SecretKey`、服务端 API Key 或管理 Token。
- HTTP 云函数使用 HTTPS 地址。
- HTTP 网关和云函数都设置频率限制/告警。
- 设置数据保留期限，例如原始事件 180 天、崩溃报告修复后 90 天删除。
- 更新安装包先上传、校验 SHA-256，再把 `published` 改为 `true`。
- 每次发布前执行 `npm run build` 和后端的 `npm run check`。

中国《个人信息保护法》要求处理个人信息具有明确合理目的、与目的直接相关并采取
对个人权益影响最小的方式；基于同意处理时，同意应在充分知情前提下自愿、明确
作出。这里按产品要求在内测版采用默认开启和暂时锁定，同时继续采用最小字段设计；
在向测试者提供软件前应显著告知该机制，正式商用前仍应让隐私政策和实际业务接受
专业合规审核，并重新评估是否应提供关闭能力。
