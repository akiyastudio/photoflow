# 后台任务与资源租约

## 原则

后台任务只表示用户可见的生命周期：创建、运行、暂停、取消、完成或失败。任务不因为“未来可能”进入某个阶段而预占该阶段的计算资源。

容量资源与路径资源通过租约独立申请：

- 容量资源：`disk-io`、`heavy-media`、`cpu-heavy`、`gpu-heavy`等有并发上限的资源。一个阶段可以原子地申请多个容量资源。
- 路径资源：带 `read`/`write` 语义的文件或目录。读读可并行；任一方为写且路径相同或为父子关系时冲突。

租约必须在阶段完成后立即释放。任务取消、失败、完成或工作进程退出时，主程序必须回收该任务的所有租约。

## 调度流程

1. 任务进入运行生命周期。
2. 工作阶段上报受信任的资源 profile 和显示阶段。
3. 主程序将 profile 映射为容量与路径资源，工作进程不得自行指定任意锁或优先级。
4. 调度器在所有请求资源同时可用时原子发放租约。
5. 工作阶段在收到授权后才开始。
6. 阶段在 `finally` 路径上释放租约。

## Python 工作进程协议

`classify.py` 使用宿主授权的标准输入/输出控制协议：

- Python 输出 `resource_request`，包含唯一 `leaseId`、受信任 `profile` 和可见 `phase`。
- 主进程验证脚本与 profile 白名单，等待调度器发放租约。
- 主进程通过 stdin 返回 `resource_granted` 或 `resource_denied`。
- Python 未收到 `resource_granted` 不得进入该阶段。
- Python 输出 `resource_release` 后主进程立即释放租约。

当前允许的导入 profile 是 `video-split`、`video-transcode`、`video-preview` 和 `raw-jpg`。协议不接受 Python 传入任意路径锁、并发上限或优先级。

## 兼容入口

旧任务定义中的 `resources`/`concurrencyGroup` 由调度器转换为一枚受管租约，不再作为任务状态本身的一部分。新代码应优先使用 `acquireResourceLease` 或 `withResources`，并将租约边界放在真实工作阶段周围。
