# P2-E-C1 · 受保护的发布归档传输

基于 [外部发布申请 #43](https://github.com/MaLaNg116/itervane/pull/43)。 [分批实施计划](../plans/p2-e-formal-release-execution.md)

1. `0532f9a` 增加 `ARCHIVE_READ`。宿主按固定 SHA-256 和长度打开已留存文件，复用私有目录、文件属主、普通单链接文件、权限以及禁止跟随符号链接的检查。现有 socket 的 Linux peer UID 检查覆盖请求。握手返回 Runner 版本，获得 Worker 应答后按固定长度传输。宿主重算摘要，只有读取完整后才提交核对回执。 [不同职责的读取和校验](https://github.com/MaLaNg116/itervane/blob/0532f9a/packages/runner/host/qualified_controller.py) · [归档存储](https://github.com/MaLaNg116/itervane/blob/0532f9a/packages/runner/host/oci_artifacts.py)
2. `5b038e1` 的 `withRetainedArchive` 使用同一受保护 socket 和固定 Runner 镜像指纹。Worker 在传输前、持续传输期间和交给消费者前复核执行权。在私有目录内独立核对字节数、SHA-256、结尾回执和 EOF。只有有效文件才交给可信回调，回调退出或传输失败都会清掉专用目录。 [Worker 读取](https://github.com/MaLaNg116/itervane/blob/5b038e1/packages/runner/src/qualified-client.ts)
3. `b608826` 原生接受路径从正式批准的操作读取第二代候选及复验回执，由实际 Worker 账户通过 socket 获得归档，再从暂存文件单独计算 SHA-256 和长度。验证错误 Runner、错误长度及执行权回调拒绝。此处使用只读验收回调，正式执行 fence 与队列认领在 C3 接入。 [原生试验](https://github.com/MaLaNg116/itervane/blob/b608826/packages/control-plane/test/native/release-archive.ts) · [正式候选接线](https://github.com/MaLaNg116/itervane/blob/b608826/packages/control-plane/test/native/worker-inspection.ts)

固定源码 `b6088262cd679a3b2ae6651caebb5b4e1ee27817`。本机 68 项宿主测试、163 项单元测试、TypeScript 与原生入口打包通过。Linux 双账户 Unix socket 试验覆盖真实宿主流、内容替换、截断、额外尾部、收到部分字节后中止、交接前执行权拒绝和消费者失败，七项均通过，私有暂存为空。该试验使用合成字节。实际 KVM 镜像、正式审批与已核对的传输证据由托管原生试验覆盖。

固定源码的 138 项 PostgreSQL 集成通过，源码指纹为 `fca38c00e90900ceeb3d8686a8ceb8f387754a47fc4f54c16bd1a66a55089b6a`。 [PR #44](https://github.com/MaLaNg116/itervane/pull/44) · [托管 KVM 验收](https://github.com/MaLaNg116/itervane/actions/runs/44919348867)

托管 OCI 路径的源码指纹一致。实际 Worker 取得第二代候选的 79,042,560 字节，SHA-256 为 `b808368bb3475a6646cf8413446b21fc47bcf3e0cc26b0ddcc8c9e5a123533fc`。候选指纹、批准操作、独立存储核对一致。错误 Runner、错误长度和回调拒绝通过，Worker 与宿主暂存均为空。

C2 使用已核对归档导入受控 Registry。C3 与 C4 分别完成正式执行权认领和 Komodo 派发。
