# 仓库首页刷新 Review Guide

基于 `1f31958` 发布后的 `main`，按 v6 蓝图和 v0.1.0 回执校正文档。首页改写提交为 `dbf9f9f`。 [本批计划](../plans/readme-refresh.md) · [英文首页](https://github.com/MaLaNg116/itervane/blob/dbf9f9f38d6c8968d06f14b8e32e973766fa1ddf/README.md) · [简体中文首页](https://github.com/MaLaNg116/itervane/blob/dbf9f9f38d6c8968d06f14b8e32e973766fa1ddf/README.zh-CN.md)

## 阅读顺序

1. 首页先交代产品用途、发布版本与语言切换，通过双语真实界面展示冻结候选的人工审批。工作流改用三个短列表项，手机宽度仍可扫读。
2. 上手路径从公开源码包和校验文件开始，用同一组命令启动双语控制面。完整执行接续 KVM Runner、受保护发布和运维文档。 [安装与升级](../reference-installation.md) · [执行宿主](../reference-runner-installation.md)
3. 展开运行模型、v0.1 适用范围和验收结果时，对应到持久化任务、双向 MCP、目标绑定和独立读回。阶段证据及开发约定从首页进入原有导读。 [v6 蓝图](../blueprint-v6.md) · [发布评测](../release-evaluation.md) · [Review Guide 索引](README.md)

## 调研样本

2026-11-27 从 GitHub 读取星标与默认分支 README。下表链接固定到阅读时的提交。

| 项目与星标 | 借鉴点 | 固定样本 |
| --- | --- | --- |
| Dify · 161,965 | 首屏用短导航直达自托管和文档，语言入口醒目。 | [README](https://github.com/langgenius/dify/blob/f37c8c8a8c16306b4a2c48ceba924afe1777afc7/README.md) |
| n8n · 212,333 | 在安装前用短列表说明可以完成的任务，并用实际界面建立上下文。 | [README](https://github.com/n8n-io/n8n/blob/467bcd35b9a50f072cbc6e53da5f62a7cdeed631/README.md) |
| OpenHands · 94,425 | 居中表达产品定位，预览具体操作，相邻链接提供自托管和架构入口。 | [README](https://github.com/OpenHands/OpenHands/blob/be48abe2585a01b4ee666e71ba5c43c47fb63772/README.md) |
| LangGraph · 45,482 | 从一句准确定位起步，简洁交代持久化 Agent 和文档入口。 | [README](https://github.com/langchain-ai/langgraph/blob/3e3dbd42c5329dd404669ccd923c005c814bee3a/README.md) |
| Coolify · 66,604 | 用真实产品画面展示部署场景，并给出适用的基础设施说明。 | [README](https://github.com/coollabsio/coolify/blob/9f2c812bd4217750f3b949b678a9ecfc78ffd584/README.md) |
| Dokploy · 38,731 | 从简明能力清单直接进入部署步骤。 | [README](https://github.com/Dokploy/dokploy/blob/956776e335fb71c99e5f1b1547f19a92ee567740/README.md) |
| Komodo · 13,032 | 以一句话说明用途，快速提供入门链接和实机界面。 | [README](https://github.com/moghtech/komodo/blob/780ac68b992094a9fccd5fffb760e0c84fd3c3d1/readme.md) |
| Open WebUI · 159,649 | 顶部切换语言，安装章节分别交代运行方式和适用条件。 | [README](https://github.com/open-webui/open-webui/blob/926f826eaef6179c092a936eede6c7363e425975/README.md) |
| Kestra · 30,377 | 在首页串起首个可运行示例、深入文档和贡献入口。 | [README](https://github.com/kestra-io/kestra/blob/767fe34931c539272bfbd9971f5469e98f364a16/README.md) |
| Firecracker · 38,246 | 把运行环境和隔离边界放在容易找到的位置。 | [README](https://github.com/firecracker-microvm/firecracker/blob/2a8d0138cdf97de97767717541dac66295f9a28d/README.md) |

## 验证记录

- 门户截图来自 v0.1.0 源码构建。Chrome 运行双语冻结发布测试，并在两种语言的批准对话框中截取画面。登录使用本地 Keycloak 与 PostgreSQL，候选证据为合成浏览器夹具。 [截图来源用例](../../packages/portal/test/browser/portal.spec.ts)
- 两版首页各核对了 27 个链接和 4 个图片引用，三个徽章地址返回有效 SVG。四个 Bash 代码块通过语法检查且两种语言逐字一致。两版页面在 1120 和 390 像素宽度下完成本地 Chrome 预览，图片加载和导航锚点正常，页面无横向溢出。
- `pnpm --silent probe:reference-install` 通过。实际核对 PostgreSQL 17、Keycloak、双语门户、外部 MCP 的 PKCE 与作用域，以及任务等待 Runner 的状态。
- 从公开发布下载回执并核对版本、三组独立交付与运维、339 项 PostgreSQL 集成测试和归档文件名。真实模型与托管固定响应的覆盖口径见同版评测。 [v0.1.0 回执](https://github.com/MaLaNg116/itervane/releases/download/v0.1.0/release-acceptance.json) · [源码包和校验](../source-release.md)
