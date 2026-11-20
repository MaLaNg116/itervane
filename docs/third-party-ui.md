# 门户设计参考与第三方动效

Itervane 自有代码继续使用 Apache-2.0；第三方工具和依赖保留自身许可。本批没有复制第三方完整 Skill、字体、图像或运行时脚本到源码中。

| 项目 | 固定版本/来源 | 本项目用途 |
|---|---|---|
| UI UX Pro Max | [2de1134 / SKILL.md](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/2de1134dc4d1cfe112934611ae5803ae17a1bd7e/.claude/skills/ui-ux-pro-max/SKILL.md)，仓库 MIT | 开发时的设计检索与 review 方法；结果经本项目选择，不是运行依赖 |
| frontend-design | [e4bb5d9 / SKILL.md](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/frontend-design/SKILL.md)，许可见该目录 LICENSE.txt | 开发时的视觉方案、自审和截图方法；不是运行依赖 |
| gsap | 3.15.1，[官方来源](https://github.com/greensock/GSAP) / [Standard No Charge License](https://gsap.com/community/standard-license/) | 门户的局部 transform 微动效 |
| @gsap/react | 2.1.2，[官方来源](https://github.com/greensock/react) / [Standard No Charge License](https://gsap.com/community/standard-license/) | useGSAP/context 生命周期清理 |
| Noto Sans CJK SC Regular | [官方 f8d1575](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf) / [SIL OFL 1.1](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE) | 仅在临时 Linux CI 安装作中文视觉验收；产品不打包字体或发起字体网络请求 |

GSAP 与 @gsap/react 不是本项目重新许可的 Apache-2.0 代码；依赖原始许可/版权声明随软件包保留。生产构建另外生成 dist/third-party-licenses.md，并在 JS 中保留许可提示，部署包应保留该说明；静态服务白名单仍只开放原有 JS/CSS，不扩大文件访问。本项目的使用范围是界面显示，没有可视化动画编辑器。本次只接入 core/CSS transform，没有 ScrollTrigger、滚动接管或外部 CDN。

依赖由 pnpm 精确锁定，包版本与完整性随锁文件维护；安装继续使用 --ignore-scripts。门户资源由原有同源构建白名单提供，CSP 不增加 unsafe-inline/unsafe-eval 或第三方脚本/字体域。GSAP 不参与授权、任务状态、批准、Runner 或数据库写入。

CI 字体先核对官方 Git blob，再固定 SHA-256 `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`，每次下载后校验，并在临时 runner 的字体目录保留 OFL。它不是用户主机的安装动作，也不改变运行时的系统字体选择。

设计决策与验收范围见[本批计划](plans/p1-ux-portal-design-motion.md)，后续代码说明见[分批 review 索引](reviews/README.md)。
