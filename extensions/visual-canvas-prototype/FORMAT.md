# QS 实验格式 0.1

扩展名 `.qs`，MIME `application/vnd.photoflow.qs+zip`。这是实验格式，**Major 0** 允许将来不兼容修改。

```text
mimetype
manifest.json
document.json
resources/assets.json
assets/sha256/<64 lowercase hex digest>
integrity.json
```

`manifest.json` 包含 `format: "com.photoflow.qs"`、`formatMajor: 0`、`formatMinor: 1`、`experimental: true`、`entry: "document.json"`。`document.json` 包含文档 `id`、`title`、单个 `surface` 与 `objects`；JSON Schema 的来源为 `packages/model.cjs` 中的 `documentSchema`，构建时也导出独立 JSON Schema。

一个 surface 使用 DIP、96 单位/英寸。`extent.kind` 为 `infinite` 或 `vertical-strip`；后者使用 `width` 与 `minHeight`，X 超界在导出时裁切，PDF 分页高度为 `width × 297/210`。原型 PDF 页面无打印边距。

对象使用 UUID、`type`、`typeVersion`、`frame`（x/y/width/height/rotation）、`orderKey`（当前为数字字符串）、`opacity`、`hidden`、`locked` 和 `payload`。原型实现 `image`、`richText`、`ink`、`connector`、`frame`；未知对象以占位显示并保留 JSON 字段。没有采用 Konva 的序列化形式。

图片 `payload.assetId` 为 `sha256:<digest>`；元数据包括 naturalWidth/naturalHeight、fit=contain/cover、0–1 crop。原图按内容摘要存储；打包时已经压缩的图片使用 ZIP STORE。原型为 embedded 资源，导出包不依赖工作数据库或宿主项目路径。

文字使用 ProseMirror doc/paragraph/text/hard_break 和 strong/em 标记；样式为 Microsoft YaHei、SimSun、Arial 中的字体、字号、颜色、行距和对齐。笔迹保留 [x,y,pressure] 原始点以及 brush 参数；`perfect-freehand` 轮廓为派生数据，不保存。

`integrity.json` 覆盖除 manifest/integrity 本身之外的内容，记录大小与 SHA-256。摘要用于损坏检测，不等价于签名或信任证明。读取先检查容器展开上限与安全名字，再核对摘要、Schema、对象 ID 唯一性和图片解码尺寸；不会按 ZIP 提供的路径直接释放任意文件。

更高主版本拒绝导入，避免误编辑；更高 minor 可在既有对象约束仍兼容时导入。未知根/对象字段原样保留；本原型不承诺保留任意未知 ZIP 条目，也未冻结 future feature 的规范。相同文档 ID 再导入已有工作区时创建新 ID 并加「导入」标题；原文件保持不变。

工作格式与交付包分离：SQLite WAL 保存当前文档元数据、按对象记录、递增修订、正逆事务、每 50 次提交的检查点、资源目录和导出任务。一次拖动只提交最终坐标。已提交事务由 SQLite FULL 同步落盘；未确认的 UI 编辑不属于持久化承诺。
