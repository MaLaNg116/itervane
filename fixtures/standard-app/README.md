# 标准目标应用：P0 参考夹具

这是仓库维护者编写的可信示例，用来准备 React/Vite + Express、单镜像、无状态目标。接口只返回明确的模拟数据；平台本身的 API、门户和认证不在这里实现。

在仓库根目录依次运行：

```sh
pnpm --filter @itervane/standard-app build
pnpm --filter @itervane/standard-app test
pnpm --filter @itervane/standard-app start
```

默认仅监听 `127.0.0.1:3000`。`/health` 返回真实 HTTP 健康状态，`/api/version` 返回运行版本，`/api/demo` 返回模拟数据；根页面和资源由同一 Express 服务提供。测试检查这些实际响应。

故障通过服务端启动配置注入，HTTP 没有切换故障的管理接口：

| 环境变量 | 值 | 作用 |
|---|---|---|
| `ITERVANE_FIXTURE_MODE` | `healthy`（默认） | 健康检查返回 200 |
| 同上 | `unhealthy` | 进程存活，健康检查返回 503；反复重启不会修好 |
| 同上 | `startup-failure` | 以 42 退出，输出固定模拟错误 |
| `ITERVANE_FIXTURE_VERSION` | 默认 `0.1.0` | 标记测试中的发布版本 |
| `HOST` / `PORT` | 默认 `127.0.0.1` / `3000` | 测试监听地址 |

`Dockerfile` 的构建上下文是仓库根目录：

```sh
docker build -f fixtures/standard-app/Dockerfile -t itervane-standard-app:local .
```

镜像以非 root 用户运行，仅声明容器内部端口。正式参考部署需要受保护入口，不能把该无认证样例直接暴露到公网。Dockerfile 当前只是待验证产物：本轮验证了本机构建和 HTTP 行为，尚未验证镜像构建、Komodo 发布或版本恢复；基础镜像 digest 在 P0.7 实测后锁定。

本机可以运行这份可信基线。评测中的变异代码、依赖安装和未来上传的项目必须进入专用虚拟机 Runner；这个示例容器不承担不可信代码隔离职责。
