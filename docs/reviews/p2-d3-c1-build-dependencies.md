# P2-D3-C1 · 标准应用离线依赖导读

本批在 P2-D3-B 的复扫证据基础上，准备标准 React/Vite 和 Node/Express 构建所需的 Linux amd64 依赖。正式构建、运行测试及镜像验收进入后续批次。 [受保护构建计划](../plans/p2-d3-c-protected-build.md)

1. `d55011f` 固定标准应用脱离工作区时的 npm 依赖锁，保留根目录 pnpm 的开发用法。样例入口与包含模拟数据的行为沿用 P0 夹具。 [固定依赖锁](https://github.com/MaLaNg116/itervane/blob/d55011f/fixtures/standard-app/package-lock.json)
2. `b81ceda` 逐项检查包路径、版本、固定 registry 地址和 SHA-512，选择适合 Linux amd64 glibc 的包。仓库 URL 和生命周期脚本都不会成为准备命令。 [锁文件读取](https://github.com/MaLaNg116/itervane/blob/b81ceda7576894e3e3b0810f6149eb4857b550b6/packages/runner/src/build-dependencies.ts)
3. 准备程序使用维护者样例，限制下载大小和时限，核对每包原始字节，再将校验过的包加入隔离 npm 缓存。记录清单、锁文件、Node/npm 版本和制品数。 [准备程序](https://github.com/MaLaNg116/itervane/blob/b81ceda7576894e3e3b0810f6149eb4857b550b6/scripts/prepare-runner-build-dependencies.ts) · [复跑命令](../../fixtures/standard-app/README.md)

代码版本 `b81ceda7576894e3e3b0810f6149eb4857b550b6` 在 Ubuntu 24.04 的类型检查和 156 项单元测试通过。Node 24.21.0 和 npm 11.19.0 完成 91 份公开 tarball 的下载、SHA-512 校验及缓存写入，共 29,086,883 字节。使用同一 npm 分发的缓存读取接口独立核对，91 个完整性地址都有内容。该次锁文件 SHA-256 为 `ec167bb4bd123cd32c494fec0afbd557b8d6d9d3f948a385610328dad20719c3`。 [专项验收](https://github.com/MaLaNg116/itervane/blob/b81ceda7576894e3e3b0810f6149eb4857b550b6/packages/runner/test/unit/build-dependencies.test.ts)

后续在合格客体内完成离线安装、受保护测试、构建与最终镜像扫描。缓存兼容性需要在固定客体版本复验。

`0fd42fe` 复用了修复模块已有的 registry 路径与 SHA-512 校验规则。复跑 156 项 Linux 单元和实际预取均通过，锁摘要、91 份制品和总字节一致。 [固定复跑版本](https://github.com/MaLaNg116/itervane/commit/0fd42fefceeff04dd31d8f086f140b47c8b27691) · [交付 PR](https://github.com/MaLaNg116/itervane/pull/26)
