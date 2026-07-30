# 照片流 CloudBase HTTP 云函数

这个 HTTP 云函数接收经过最小化处理的桌面端统计与崩溃报告，返回版本更新
信息，并提供仅管理员可访问的统计汇总接口。安装包、FFmpeg 对应源码包和
更新接口只从 `app_releases` 读取安装包 HTTPS 地址及其 SHA-256。开源源码
归档和许可证资料按发行版本单独留存，不写入更新数据库。

Collections required in the same CloudBase environment:

- `analytics_events`
- `crash_reports`
- `app_releases`

不要给这些集合开放客户端读写权限。桌面软件只访问 HTTP 云函数；
CloudBase 凭据和 `PHOTOFLOW_ADMIN_TOKEN` 只保存在云函数环境变量中。

发布记录的必填产物字段只有 `downloadUrl` 和 `sha256`。

上传包使用仓库根目录下的 `output/photoflow-cloud-function.zip`。详细操作见
`../../docs/CLOUDBASE_ANALYTICS_GUIDE.md`。
