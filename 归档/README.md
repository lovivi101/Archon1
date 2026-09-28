# 归档

这里的项目已停止维护，仅保留作参考，不参与构建和测试。

| 目录 | 原位置 | 说明 |
|---|---|---|
| `Cocos_Client` | `客户端/Cocos_Client` | 早期 Cocos Creator 客户端，已由 `客户端/Godot_Client` 取代 |
| `Due_Server` | `服务器端/Due_Server` | 早期 Go（Due 框架）服务端，已由 `服务器端/AvalonTsServer` 取代 |

两者使用的仍是旧版协议：自报 `userId` 登录、单房间 `888`。当前服务端只在开发环境（或设置 `AVALON_ALLOW_LEGACY_LOGIN=1` 时）接受这种登录方式。
