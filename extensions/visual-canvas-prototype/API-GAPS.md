# 使用的公开 API 与缺口

依据本 checkout 的 `docs/PLUGIN_HOST_API.md`、`docs/PLUGIN_DEVELOPMENT.md`、`component-sdk/index.d.ts` 和对应公开 JSON Schema。需求附件中的建议不是宿主已经实现的接口。

## 当前原型可直接使用

| 需求 | 公开接口 |
| --- | --- |
| 入口、选择、主题与页面生命周期 | fullPage / toolbarAction / contextAction / exportProvider + `window.photoFlowComponent` |
| 项目图片与预览 | `project.media.page`、`project.media.variants` |
| 外部图片 / `.qs` 文件读取 | `dialogs.openFiles` / `authorizeFiles` → `project.input.tokens.materialize` |
| 插件数据库与资产 | `component.storage`、`component.media` |
| 项目内结果写入 | `project.output.stage/write/validate/commit` |
| 状态、取消、恢复 | `tasks` 与插件私有任务记录 |
| 定位已发布文件 | `dialogs.revealOutput`，使用提交收据 |

界面只调用插件自己的版本化 RPC。读取原图采用 Host 签发的一次性令牌。大图片与导出字节留在服务端私有存储/stage；不经 2 MiB renderer RPC，也不使用浏览器下载作为项目导出。

## 尚未公开的能力

1. **按项目相对路径读取普通文件的输入令牌。** 当前 `project.files.page/search` 只列举普通文件；不能由选中的 `.qs` 相对路径直接签发读取令牌。建议增加受 scope 限制的 `project.files.inputToken`（名称仅为建议）。原型需要通过系统文件选择器重新选择 `.qs`；并不阻止便携文件导入。
2. **项目外的受控另存为。** `dialogs` 当前没有 `saveOutput`。建议增加返回输出授权/收据的受控保存接口；原型只能向当前项目的「视觉画布」目录发布。
3. **项目文件/资源变化订阅。** 当前没有 `project.files.watch` 或等价公开订阅，用于链接资产的修改、重命名、删除和版本切换通知。原型存储导入时的私有副本，未提供实时链接模式。

`component.binaryTransfer` 也没有公开，但当前垂直流程不需要它：导入通过读取令牌进入服务，导出由服务直接写 stage。以后如要从 renderer 高频传输大位图，可先评估插件自己的有界分块 RPC，再决定是否需要通用 Host 二进制通道；不能将未存在的能力写入清单。

## 与附件不同的契约

当前 Host API 是唯一、无版本协商的契约。插件声明 `componentHost.contractVersion: 2`；不填写 `minHostApiVersion: 8`，不增加 API 7/8 协商。组件 RPC 使用小写、连字符和 `.v1` 后缀。附件中先修改主程序 API 的建议未执行。

本原型没有为任何缺口读取宿主内部数据库、导入主程序源代码、借用旧私有 IPC，或绕过项目输出事务。
