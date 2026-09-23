# Code Index

## 场景入口

- `assets/Main.scene`：主场景，`Canvas` 上挂 `AvalonDemoApp`。
- `assets/Scripts/App/AvalonDemoApp.ts`：阿瓦隆 Demo 客户端运行时 UI，负责按钮、座位、日志和主流程操作。

## 游戏状态与协议

- `assets/Scripts/Game/AvalonGameTypes.ts`：Route、Role、GameStage、任务人数矩阵和展示名称。
- `assets/Scripts/Game/AvalonGameState.ts`：客户端单例状态，兼容 Go 结构体字段和 JSON 小驼峰字段。
- `assets/Scripts/Network/AvalonProtocol.ts`：due 默认 `seq + route + JSON body` 的编码/解码。
- `assets/Scripts/Network/AvalonNetwork.ts`：WebSocket 连接、状态回调、route handler 注册和消息派发。
- `服务器端/AvalonTsServer/src/server.ts`：NestJS 启动入口；`src/app.module.ts`：模块注册；`src/health.controller.ts`：健康检查；`src/game.gateway.ts`：WebSocket 连接/消息入口；`src/game.service.ts`：协议、房间和游戏逻辑；`scripts/smoke-test.js`：直接加载客户端网络类的联通烟测。
- `服务器端/AvalonTsServer/compose.yaml`、`Dockerfile`：PostgreSQL + 数据库迁移 + NestJS 部署；`src/database.service.ts`：连接池和玩家资料持久化；`scripts/migrate.js`、`migrations/`：版本化 SQL 迁移。

## 常用搜索

```powershell
rg --line-number "Route|GameStage|Role" assets/Scripts
rg --line-number "registerHandler|send\\(" assets/Scripts
rg --line-number "AvalonDemoApp" assets/Main.scene assets/Scripts
```
