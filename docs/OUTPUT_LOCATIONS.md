# 输出目录约定

| 内容 | 位置 |
| --- | --- |
| 安装包、组件 ZIP、服务端部署 ZIP、离线包、打包候选 | `artifacts/installers/`，允许按类型分子目录 |
| 不可变交付物及 DELIVERY-MANIFEST | `artifacts/installers/releases/<commit>/<version>/` |
| 发布 JSON | `artifacts/installers/metadata/` |
| 发布日志、尝试记录、锁及内部质量记录 | 私有根目录的 `operations/releases/` |
| 当前发布的人工批准索引 | 私有根目录的 `audits/legal/RELEASE_APPROVAL.json` |
| 业务备份、审查材料、内部文档、未脱敏截图 | 私有根目录的 `backups/`、`audits/`、`diagnostics/` 等 |
| 构建中间文件与依赖 | 保留既有被忽略的构建目录；不作为最终交付物 |

当前工作站的私有根目录在不提交 Git 的 `.photoflow-paths.local.json` 中配置：

```json
{ "privateRoot": "C:/dev/app/app1visual/photoflow-private" }
```

其他工作区可以设置 `PHOTOFLOW_PRIVATE_ROOT`。路径必须位于源码仓库之外；缺少配置或目标不可访问时应明确失败，不能将私有材料写回源码目录。

Node 脚本使用 `scripts/project-output-paths.cjs` 的 `privateOutputPath()`、`releaseOperationsRoot()` 和 `installersRootFor()`。临时审查脚本也应先解析目标目录再写文件。测试使用独立的临时私有根目录，不写真实业务资料目录。

`npm run release:approval -- --manifest <path>` 会根据不可变交付清单，在上述私有位置生成已经填入版本、源码提交和两个发布哈希的待批准草稿。命令不会自动批准，也不会覆盖已有记录；旧记录必须先人工核验并归档。

日常正式发布使用单一入口 `npm run release`。它依次准备不可变 staging、生成或复用私有批准文件、等待人工确认、执行最终门禁并发布；发布说明等参数会转交给 `release:publish`。分步命令保留用于审查、恢复和故障定位。

`.gitignore` 不会移动文件，也不会替任意外部程序改变保存位置。这项约定由项目指令和已接入的生成脚本共同执行。新增脚本必须遵循同一规则。

旧目录中的发布锁或尝试记录不能直接忽略：需要先停止旧发布进程、核实状态，再保留原记录完成迁移。软件包输出位置的改变不赋予候选任何发布批准。

服务端部署包放入 `installers/cloudbase/` 后仍属于私有部署材料。公开分发必须依据已批准的交付清单，不能把整个 installers 目录自动上传。
