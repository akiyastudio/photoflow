# 高级 RAW 解码组件

该组件使用 rawpy 携带的 LibRaw，在相机 RAW 不包含可用 JPEG 预览时，将传感器数据显影为浏览器可显示的 JPEG。

- 缩略图请求使用 `half_size=True`，降低首次浏览的内存和耗时。
- 原图预览使用完整分辨率解码。
- 使用相机白平衡、8-bit sRGB 输出，不修改 RAW 源文件。
- 每次解码运行在独立进程中，任务结束后释放整套 RAW 解码内存。
- 输出保留 RAW 方向信息，缩略图与预览窗口可以复用同一结果。

开发环境先运行 `npm run setup:raw-decoder`，再运行 `npm run build:raw-decoder`。生成的 ZIP 位于 `release`，由设置中的组件页面安装。
