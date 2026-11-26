# v0.1 源码发布 / Source release

源码归档包含双语门户、Worker、Runner、参考配置和固定依赖。发布清单提供 Git commit、代码树、打包工具链和各文件的 SHA-256。参考构建工具链为 Ubuntu 24.04 x86_64、Node.js 24.14.0 与 pnpm 11.9.0。 [组件与许可证](release-components.md)

## 下载并验证

将同一次发布的文件置于一个目录。在该目录下核对全部打包文件，再解开源码归档。构建门户并按参考安装文档准备 PostgreSQL、Keycloak 和本机安装目录。

```sh
sha256sum --check SHA256SUMS
tar -xzf itervane-0.1.0.tar.gz
cd itervane-0.1.0
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:portal
```

启用项目执行、受保护发布和运维前，按同版文档登记执行与部署目标并配置模型、隔离和独立读回。保留已有数据库、档案、配置及 Keycloak 状态的安装按升级步骤操作。 [控制面安装与升级](reference-installation.md) · [KVM Runner](reference-runner-installation.md) · [受保护发布](reference-release-installation.md) · [控制面备份](control-plane-backup.md)

## 重建发布资产

在干净的 Git checkout 中切换至发布清单记录的完整 commit。按同一工具链安装冻结依赖。使用新目录作为输出，再以同一 commit 重建并比较。`dependency-licenses.json` 记录当前平台已安装的 npm 包。`release-manifest.json` 保存源码与文件绑定，最后生成 `SHA256SUMS`。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --silent release:source /tmp/itervane-release
pnpm --silent release:source /tmp/itervane-release-repeat
diff -qr /tmp/itervane-release /tmp/itervane-release-repeat
```

`Source Release` 托管流程从归档独立解包、冻结安装和构建，并用实际 PostgreSQL、Keycloak 与 Chrome 验证双语门户和外部 MCP。安装回执绑定源码树与归档摘要。三条闭环的 KVM、真实备份恢复和升级各保留独立验收。 [源码发布流程](../.github/workflows/source-release.yml) · [验收索引](reviews/README.md)

## English

Download the files from one release and run `sha256sum --check SHA256SUMS` in their directory. Extract `itervane-0.1.0.tar.gz`. Install using `pnpm install --frozen-lockfile --ignore-scripts`, build the portal and follow the pinned reference installation. Use the same database major and keep the original identity and configuration when upgrading. [Reference installation](reference-installation.md) · [Components and licenses](release-components.md)

To recreate the archive and license index, use the commit, toolchain and frozen dependency graph from `release-manifest.json`. Run `pnpm --silent release:source <new-output-directory>` from that clean checkout. Compare the resulting files and verify their checksums. The hosted archive test saves an installation receipt tied to the archive digest and Git tree.
