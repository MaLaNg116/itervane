# P1-D1：源码检查准备与隔离执行前的底座

- 日期：2026-11-18；[计划与 D2/D3 路线](plans/p1-d-isolated-source-inspection.md)、[ADR 0004](decisions/0004-isolated-source-inspection.md)、[review guide](reviews/p1-d-source-inspection.md)。
- 运行仍依赖 P1-A/B/C 的身份、数据库、Worker 与门户；本批新增迁移 0005。

## 实际交付

`任务提交 → Worker 获得既有执行权 → source.inspect 保存不可变检查计划 → Runner 不可用 → 真实图暂停 → API/MCP/双语门户查询同一计划`

检查计划关联 task/run、请求的完整 commit、两种扫描 profile 及配置指纹、所需 VM、资源和网络约束。它是待执行工作，不是已下载源码、已验证快照或已完成的扫描。`sourceFetched/snapshotVerified/scanCompleted` 当前均固定 false；没有生产报告上传或“已验证 Runner”登记接口。

`packages/runner` 另提供纯快照校验与扫描报告归一化库，当前不被 Worker 用来处理提交的仓库。真实 CLI 只用于维护者生成的合成样例探针，结果不会写入业务任务。

## 升级与运行

1. 停止旧 API/Worker，按既有流程备份专用平台数据库。
2. 安装锁定依赖；由独立迁移账号执行 `pnpm db:migrate`，历史 SQL 不改写。
3. 对运行角色重新执行/核对 `packages/control-plane/ops/runtime-grants.sql`，纳入新表的 DML；运行角色仍无 DDL 和 TRUNCATE。
4. 重新构建门户并启动 API、Worker。身份和连接池配置沿用 P1-C/P1-B，没有 Runner enable 或 hypervisor 凭证配置。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm db:migrate
# 管理员核对运行角色授权
pnpm build:portal
pnpm start:api
# 另一终端 pnpm start:worker
```

迁移增加 `inspection_plans`、run/task 复合外键及禁止 UPDATE/DELETE 的触发器。计划每个逻辑 run 唯一；恢复读取原计划，不原地替换版本。首次 source.inspect 尚未执行，或者历史任务沿用旧工具缓存时，可显示 `not_prepared`；迁移不会伪造历史检查记录。

源码、扫描报告、大日志和漏洞库不进入该表。字段 `preparedFence` 记录创建时的执行权代次，不给后续动作授予权限；每次工具调用仍重新检查当前 fence、租约、取消及项目权限。

## 查询与多语言

- HTTP：`GET /v1/tasks/:taskId/source-inspection`，使用原有 API audience 和当前项目读取权限。
- MCP：`get_source_inspection({taskId})`，需要 MCP audience 和 `itervane:read`，复用同一 InspectionService。
- 门户：任务详情新增“源码检查准备”卡片，显示请求版本、计划 SHA-256、受保护扫描器版本及明确阻断原因，支持 en/zh-CN。
- 该查询不获取仓库、不创建计划、不开始扫描；未知/撤权项目沿用 not_found，匿名请求拒绝。

`/v1/capabilities` 的 stage 为 `p1-d1`，新增 `sourceInspectionPlanning: true`；`sourceSnapshots/sourceScanning/taskExecution/sandbox/deployment/operations` 仍为 false。严格解析旧 capability 响应的客户端需要同步更新契约。

## 快照与扫描库

快照校验接收有界的原始 commit 对象和文件字节，重新计算 Git blob/tree/commit，兼容 SHA-1/SHA-256 Git 对象格式，并形成含文件大小/模式/SHA-256 的稳定 manifest。它验证内容与请求 commit 的关系，不验证仓库所有权、签名或来源通道。后续候选必须继续绑定 manifest SHA-256，不能只依靠 Git SHA-1 或自报 commit。

输入仅支持便携相对路径、普通/可执行文件；拒绝链接、gitlink、LFS 指针、危险路径、重复/大小写冲突及超限。限额为 5000 文件、单文件 2 MiB、总内容 32 MiB、commit 对象 64 KiB。该库不提供网络、解压、checkout、依赖安装或执行接口；这些仍须在经验证 VM 内完成。

扫描器版本锁定 Gitleaks 8.30.1 与 Trivy 0.76.2。profile 显式选择外置受保护配置、空忽略清单和退出码；不允许项目用 `.gitleaks.toml`、`.gitleaksignore`、`.trivyignore` 或 inline allow 取消强制检查。Trivy 扫描阶段 offline，禁止自动更新库；可信准备流程另行提供数据库。

归一化只保留受限规则/CVE 标识、受快照约束的位置、严重度和证据指纹；丢弃 Secret、Match、作者、描述、包文本、源码片段及原始 stderr。超时、非法 JSON、退出码不一致、缺库/陈旧库、空依赖清单和无发现分别处理。完成扫描不表示风险已消除或可以发布。

覆盖只包括固定快照的密钥模式与 npm package-lock 已知漏洞。完整 Git 历史、二进制、压缩包/多层编码、PII、鉴权和业务逻辑不据此判定安全；库龄上限初定 72 小时，未来政策调整须版本化。

## 真实 CLI 验证

```sh
pnpm check
pnpm test:integration
pnpm test:portal
pnpm probe:scanners
```

浏览器测试环境沿用 P1-C。`probe:scanners` 不读取 `.env`，不接收源路径或 URL 参数；只在 `.reports/p1-d/git-<随机值>` 创建合成文件和本地 Git 对象，不执行文件中的脚本或安装项目依赖。

探针从官方 GitHub 固定版本下载 Windows/Linux x64 资产，按源码中固定 SHA-256 校验后，仅解出 CLI；缓存目录 `.cache/p1-d-tools` 每次重新验档与提取，不信任可修改的校验收据。子进程环境不继承模型/平台凭证。暂不支持其他 OS/架构。

Trivy 数据库通过官方 `ghcr.io/aquasecurity/trivy-db:2` 准备；随后离线扫描，记录库时间和文件 SHA-256，扫描前后核对数据库不变。OCI 标签负责取得当前库，实际内容哈希记录本次使用的身份，不宣称跨日期得到完全相同漏洞结果。

五项实际验证：密钥检出、密钥移除后无发现、Trivy 缺库失败、lodash 4.17.20 中指定 CVE 检出、4.17.21 中该 CVE 不再出现。最后一项不承诺修复版本没有其他漏洞。扫描源码全部由维护者脚本生成，项目自带忽略文件/注释不能关闭强制配置。

本地镜像站下载曾失败，改用同为官方源的 GHCR 后完成真实漏洞扫描；未关闭 TLS、未注入私有凭证、未用假数据库通过。网络或库准备失败时探针记录 blocked 并以非零退出，不能作为干净结果。

脱敏报告位于 `.reports/p1-d/scanners.json`，包含受控范围、源码/manifest 指纹、工具/配置版本、规范化发现和数据库身份；控制台仅输出发现计数。Git 测试目录经归属与绝对路径检查后清理，报告/工具缓存不提交 Git。CI 新增独立 scanners 任务，保留原 deterministic 与真实浏览器回归。

## KVM 缺失时的验收边界

当前证明了纯字节快照校验、真实 Git 对照、可信合成样例扫描、PostgreSQL 授权/原子性/fencing、门户/MCP 记录一致性。尚无生产 VM 控制器、提交仓库获取或任务扫描证据。

D2 必须实际证明 VM 镜像、网络出口/元数据/宿主/跨任务拒绝、资源和超时限制、取消、进程树终止、销毁和残留清理。D3 才接入真实任务、受控 Git 获取/数据库导入、产物发布及故障重领核对。普通容器、软件声明和 fixture 成功均不能替代这些证据；完整 P0/P1/MVP 继续未验收。
