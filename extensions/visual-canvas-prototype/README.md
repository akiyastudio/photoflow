# QS 视觉画布原型

独立的 PhotoFlow Component Host V2 插件，源码与构建依赖全部位于此目录。主程序、主程序依赖、API 契约和其他组件不需要修改。只依赖公开的 `component-sdk` 与 Host API，不导入宿主业务代码。

## 使用

源码开发入口由 `component.json` 贡献到「视觉画布」工具栏、媒体右键和项目导出菜单。先执行下面的构建命令，然后在 PhotoFlow 中按现有开发组件流程载入。右键入口打开后，点击「添加当前选择」导入此次选择。

```powershell
cd C:\dev\app1\extensions\visual-canvas-prototype
npm ci
npm run build
npm test
```

构建脚本仅生成本插件，组件 ZIP 位于：

`C:/dev/app1/artifacts/installers/advanced/PhotoFlow-visual-canvas-prototype-0.1.0-win32-x64.zip`

这是 Windows x64 候选包，包含包内清单、编译后的 UI / 服务、resvg 本机运行库、第三方许可证和内容摘要。旁边的 `.sha256` 用于核对 ZIP；包内摘要不是发布签名，也不会绕过宿主完整性准入。安装或注册应继续使用 PhotoFlow 的组件管理流程。此目录没有修改宿主目录、安装目录或用户组件注册表的脚本。

快速体验独立预览：

```powershell
npm run preview
```

在 `http://127.0.0.1:4179` 打开界面。预览使用实际插件服务与 SQLite，但 Host API 由独立测试实现提供，不能作为真实 PhotoFlow 安装验收。预览中的素材是程序生成的色彩习作，不读取真实业务项目。测试图片、数据库和输出直接保存到项目配置的私有 `diagnostics/visual-canvas-prototype/`，不进入源码仓库。独立预览的系统选择器不模拟用户本机授权，应在 PhotoFlow 中验证。

## 可以操作的功能

- 当前选择、项目媒体列表点击/拖入、系统选择器、多文件拖入；支持 JPEG、PNG、WebP、GIF。
- 单选、Shift 多选、框选、拖动、多对象变换、比例缩放、旋转、图层前后移动、网格吸附。
- 完整显示 / 填充，中心非破坏性裁切。
- 规则网格、等高行、填满矩形；一次排版对应一个事务、一次撤销。
- ProseMirror 中文文字编辑、粗体、斜体、字号、颜色、对齐、行距与自动高度。
- 手写、整笔删除、自由连线、矩形画板。鼠标笔迹和 PointerEvent 压力数据使用同一模型。
- 无限画布 / 固定宽度长文档，A4 分页参考线与横向越界提示。
- SQLite WAL、增量对象事务、逆操作历史、修订号 CAS、周期检查点；重新打开会载入已提交内容。
- `.qs` 实验便携包导出/导入；图片按 SHA-256 打包，未知文档字段和未知对象保留。
- PNG（全部、选择、画板）与多页 PDF，通过 `project.output` 的 stage → write → validate → commit 保存到当前项目。
- 分页导出任务、保留任务状态、相同幂等键恢复不明确的提交结果。

快捷键：V 选择，H 平移，T 文字，B 手写，L 连线，F 画板；空格拖动；滚轮缩放；Ctrl+A 全选；Ctrl+Z 撤销；Ctrl+Shift+Z 重做；Ctrl+S 打开 `.qs` 保存窗口。

## 原型边界

- `.qs` 为 Major 0，不承诺与未来正式格式完全兼容；没有 `.canvas` 导出。
- 界面使用轻量 DOM 外壳，Konva 命令式场景，ProseMirror 编辑层；独立领域模型不保存 Konva JSON。
- PDF 每页栅格化，文字暂不能搜索/复制，尚未实现字体嵌入及矢量 PDF。共享的近似字宽排版保证预览/导出采用相同行结构，但与 DOM 输入时的字距、换行仍可能存在差异。
- 字体使用 Windows 系统的 Microsoft YaHei、SimSun、Arial；没有内置字体。跨平台或缺少这些字体的机器尚未验收。
- RGB 普通导出；没有印刷色彩管理、高级图片滤镜、表格、持续约束布局、协作或真正的链接资产实时同步。
- 图片显示经过 RBush 视口裁剪，缩略图/预览分级，最多缓存 100 个解码条目；极小缩放时仅优先加载 90 张可见图片，其余显示占位。尚无按实际字节计费的 500 MB 缓存预算。
- 单张原图 64 MiB / 1.5 亿像素，便携资源 256 MiB，单张输出边长 10000 / 3200 万像素，PDF 最多 200 页；大长文档优先 PDF。原型限制低于 Host 的 2 GiB 输出上限。
- 工作资源与撤销日志保守保留，没有自动垃圾回收，避免误删仍被文档或历史引用的图片。磁盘使用可能持续增长。
- 有序服务请求、单次拖动单次提交；尚未实现自动合并并发编辑。发生修订冲突或结果不明确时停止后续编辑并提供重新载入。
- 图片导入逐张提交，出错时保留此前已导入图片并显示数量；不是整个导入批次原子回滚。
- 页面正在组合输入或刚输入但尚未提交的文字不属于崩溃恢复保证；状态栏只在事务确认后显示已保存。
- 宿主普通请求限时 60 秒。导出按页推进；极端大文档的最终 PDF 汇总与 `.qs` 打包仍受单次时限约束。

真正的 Host 沙箱/安装准入、真实高分辨率 500/1000/2000 图片的帧率与内存、手写笔硬件压感、系统中文输入法组合事件、字体缺失与跨机器打印仍需在实际环境验收，不能用测试替身结果代替。

## 结构

| 目录 | 职责 |
| --- | --- |
| `packages/model.cjs` | 独立对象模型、事务、布局、画布边界 |
| `packages/display.cjs` | 共享显示清单、文字行布局、笔迹、SVG |
| `service/repository.cjs` | SQLite 持久化、CAS、撤销/重做、资源目录、任务记录 |
| `service/format.cjs` | `.qs` 容器、摘要、路径/解压上限校验 |
| `service/application.cjs` | 公开 Host API 适配、图片导入、分步导出 |
| `ui/` | 编辑器、属性、资源/文档/图层面板、主题与窄窗口布局 |
| `scripts/build.cjs` | 清单 Schema 校验、自包含候选 ZIP 和许可证收集 |
| `tests/` | 事务、恢复、500 张小图、20 页 PDF、容器往返、JSONL 协议 |

第三方技术资料：[Konva 文本编辑](https://konvajs.org/docs/sandbox/Editable_Text.html)、[ProseMirror Guide](https://prosemirror.net/docs/guide/)、[resvg-js](https://github.com/thx/resvg-js)、[pdf-lib](https://pdf-lib.js.org/)。
