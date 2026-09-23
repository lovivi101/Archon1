# Avalon NestJS 服务端

服务端现已迁移到 NestJS 11：使用 `@nestjs/platform-express` 提供 HTTP 接口、`@nestjs/platform-ws` 提供 WebSocket 网关。Cocos 客户端当前协议保持不变：

```text
2 字节 little-endian seq
2 字节 little-endian route
JSON body
```

默认监听 `0.0.0.0:8888`，所以客户端可以继续使用 `ws://127.0.0.1:8888`。健康检查地址为 `http://127.0.0.1:8888/health`。
如果 `8888` 已被旧服务占用，可在 PowerShell 中先运行 `$env:PORT = '8889'`，再运行 `npm start`，并在 Cocos 的服务器地址框填写 `ws://127.0.0.1:8889`。

## 启动

```powershell
npm install
npm run build
npm start
```

开发模式：

```powershell
npm run dev
```

也可以双击 `start.bat`。

## 支持的链路

登录 -> 加入房间 -> 准备 -> 身份下发 -> 队长组队 -> 全员投票 -> 任务 -> 刺杀 -> 结算。

房间默认包含 4 个 AI 玩家和房间号 `888`。AI 会自动完成队长组队、投票和任务动作；人类玩家可以用现有 Cocos Demo 的按钮继续推进。`AVALON_NIGHT_SECONDS` 和 `AVALON_AI_TICK_MS` 可以调整本地演示速度。

Go Due 服务端仍保留在 `服务器端/Due_Server`，作为后续 Redis、etcd、gRPC 集群化实现。这个 TypeScript 服务不复用 Due 的注册中心，因此本地联调不需要预先启动 Redis 和 etcd。

## 代码结构

- `src/server.ts`：Nest 应用启动、监听端口与 WebSocket 适配器。
- `src/app.module.ts`：控制器、网关、游戏服务的依赖注入注册。
- `src/health.controller.ts`：`GET /health` 诊断接口。
- `src/game.gateway.ts`：WebSocket 连接、断开和二进制消息入口。
- `src/game.service.ts`：现有协议、房间规则、AI 与消息发送。下一阶段可继续拆分为认证、房间、对局模块。

NestJS 提供成熟的应用结构和运行机制，但不会自动保证现有阿瓦隆规则正确。当前登录玩家资料可持久化到 PostgreSQL；房间、身份和对局仍是内存演示实现，重启会丢失，尚未接入正式鉴权，不应直接作为生产服务发布。

## Docker Compose 一键部署（Linux / macOS / Windows）

需要预先安装 Docker Engine + Compose 插件，或 Docker Desktop。Docker 会拉取 PostgreSQL 17 镜像和 Node 22 镜像，无需在宿主机单独安装数据库或 Node.js。

1. 将 `.env.example` 复制为 `.env`，务必把 `POSTGRES_PASSWORD` 改成唯一的长随机密码。`.env` 已加入 Git 和 Docker 构建忽略列表。
2. 在本目录运行 `docker compose up -d --build --wait`。Compose 会等待 PostgreSQL 健康、执行 `migrations/*.sql`，再启动服务器。数据库保存在 `pgdata` 命名卷中。
3. 访问 `http://127.0.0.1:8888/health`；返回 `ok: true`、`database: "ready"` 表示服务和数据库可用。`HOST_PORT` 可改宿主机端口，容器内仍是 8888。

```text
docker compose ps
docker compose logs --tail=200 server
docker compose logs --since=1h server
docker compose logs --tail=200 migrate
docker compose down
```

服务端在 Compose 中输出单行 JSON 日志到标准输出；HTTP 响应带 `X-Request-Id`（成功的健康检查不写访问日志），WebSocket 连接有 `connectionId`，路由日志包含 `seq`、`route` 和耗时。日志不记录包体、昵称或密码。Docker 的 `json-file` 日志每个服务最多保留 5 个 10 MB 文件，过期日志会轮转删除；长期留存需要接入集中日志系统。数据库没有对宿主机开放端口。

当前数据库持久化的是登录玩家资料，**不是正式账号验证**：客户端提交的 `userId` 仍可自行指定。房间、身份、对局进度依旧在进程内存中，重启会丢失，当前只能运行单个服务实例；要上线多人/多副本，还需实现正式鉴权、房间持久化或共享状态、备份、TLS/WSS、反向代理和完整对局测试。请不要用 `docker compose down -v`，那会删除数据库卷。

## 连通性验证

服务器启动后，在另一个终端执行：

```powershell
npm run test:smoke
```

烟测直接加载 Cocos 项目中的 `AvalonNetwork`，在独立临时端口启动全新 NestJS 应用，依次验证登录、加入房间、准备、游戏开始、身份下发和阶段切换。成功时会输出 `PASS` 以及实际收到的路由序列；可反复运行，不会占用开发服务的 8888 房间。

在 Creator Preview 的连接框填写 `ws://127.0.0.1:8888`。手机或微信开发者工具连接到另一台电脑时，改用服务电脑的局域网地址；真机发布需要可访问的 `wss://` 地址及对应平台域名配置。
