# P3-A1 · Whiskers 只读运维观察导读

基于 [发布故障验收 #65](https://github.com/MaLaNg116/itervane/pull/65) 接续 [P3-A 计划](../plans/p3-a-whiskers-observation.md)。适配器版本 `b9caee0520230c7cf3bae6efe35fccbbafa64b2c`，托管验收入口版本 `176ca891a266f7befc1bc759fcd3efa3b5ba1684`。

1. 构造时固定维护者登记的 Whiskers 地址、服务器 ID、完整 Docker 容器 ID 和独立 Read 密钥。请求只抵达该地址的 `/mcp`，不跟随重定向。依次在连接前、工具发起前和返回事实前校验授权。运行入口预定由 P3-A2 从当前项目和已发布版本解析目标。 [适配器](https://github.com/MaLaNg116/itervane/blob/b9caee0520230c7cf3bae6efe35fccbbafa64b2c/packages/control-plane/src/runtime/whiskers-observation.ts#L41)
2. MCP 初始化必须匹配 Whiskers 0.15.0。适配器只调用 `get_container_details`，连接与请求共用 10 秒时限。HTTP 响应和工具文本分别限制为 64 KiB 和 8 KiB。只认原生输出首部的 ID、运行状态和服务器字段，将目标匹配后的四项事实返回，忽略标签、端口等其余字段。原生错误通过有限机器原因返回。 [原生字段来源](https://github.com/LupusMalusDeviant/Whiskers/blob/e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4/src/Whiskers/Mcp/Tools/ContainerTools.cs#L34) · [投影与调用](https://github.com/MaLaNg116/itervane/blob/b9caee0520230c7cf3bae6efe35fccbbafa64b2c/packages/control-plane/src/runtime/whiskers-observation.ts#L29)
3. 单元验证跑真实 SDK 的请求协议，对照目标和服务版本、撤权、取消、超限及标签注入。托管工作流保留先前的原生人工重启验收，再由浏览器签发独立 Read 密钥，读取运行、退出和不存在的容器。暂停本轮 Whiskers 直到观察超时，恢复后重读。整个过程使用专用主机及本轮登记的夹具。 [确定性测试](https://github.com/MaLaNg116/itervane/blob/b9caee0520230c7cf3bae6efe35fccbbafa64b2c/packages/control-plane/test/unit/whiskers-observation.test.ts) · [原生检查](https://github.com/MaLaNg116/itervane/blob/176ca891a266f7befc1bc759fcd3efa3b5ba1684/packages/portal/test/native/whiskers.ts#L151)

本机 TypeScript 和 210 项单元测试通过，托管原生验证待归档。P3-A2 负责项目授权、发布证据与持久化入口，P3-A3 负责诊断角色。适配器接受非健康运行状态作为观察事实，业务健康由后续独立证据判断。
