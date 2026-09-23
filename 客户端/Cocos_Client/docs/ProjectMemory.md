# Project Memory

本文件记录当前 Cocos Creator 项目中已经确认的 MKFramework 约定，供后续开发前快速阅读。

## 项目状态

- 当前项目使用 Cocos Creator `3.8.7`。
- 已安装 MKFramework，项目记录版本为 `v1.1.5`。
- 框架源码入口：`extensions/MKFramework/assets/MKFramework/Framework/MKInit.ts`。
- 类型声明入口：`extensions/MKFramework/@types/MKFramework/mk.d.ts`。
- 已配置 `import-map.json`，可通过 `import mk from "mk"` 使用框架。
- `settings/v2/packages/project.json` 已配置 `script.importMap = "project://import-map.json"`。

## MKFramework UI 架构

官方文档入口：

- UI 架构：https://mkframework.muzzik.cc/docs/module/module/ui
- Layer：https://mkframework.muzzik.cc/docs/module/module/ui/layer
- LifeCycle：https://mkframework.muzzik.cc/docs/module/module/ui/life-cycle
- SceneDrive：https://mkframework.muzzik.cc/docs/module/module/ui/scene-drive
- ViewBase：https://mkframework.muzzik.cc/docs/module/module/ui/view-base
- StaticViewBase：https://mkframework.muzzik.cc/docs/module/module/ui/static-view-base
- UI 管理器：https://mkframework.muzzik.cc/docs/module/module/ui/ui-manage

UI 继承主线：

```text
cc.Component
  -> mk.Layer
    -> mk.LifeCycle
      -> mk.SceneDrive
      -> mk.ViewBase
      -> mk.StaticViewBase
```

常规开发判断：

- 动态弹窗、页面、可被 UI 管理器打开关闭的预制体：继承 `mk.ViewBase`。
- 场景上常驻脚本、入口 Canvas 逻辑、不需要 `mk.uiManage` 管理但要生命周期的模块：继承 `mk.StaticViewBase`。
- 只手动 `addComponent` 的 `mk.LifeCycle` 派生组件，如果不是通过场景驱动或 `mk.uiManage.open` 启动，需要调用 `drive(initData)` 手动驱动生命周期。

## 组件基类功能

### mk.Layer

本地源码：`extensions/MKFramework/assets/MKFramework/Framework/Module/MKLayer.ts`

- 控制同一父节点下的显示顺序，本质是维护 `siblingIndex`。
- 先按 `layerTypeNum` 排序，再按 `childLayerNum` 排序。
- `layerTypeNum` 类型来自 `GlobalConfig.View.LayerType`，可通过修改 `extensions/MKFramework/assets/MKFramework/Config/GlobalConfig.ts` 调整层类型。
- `childLayerNum` 是同层类型内的层级，层级越大越靠上。
- 注意：动态修改 `layerTypeNum` 不会立即刷新层级；层级刷新主要发生在 `onEnable` 或修改 `childLayerNum` 时。

### mk.LifeCycle

本地源码：`extensions/MKFramework/assets/MKFramework/Framework/Module/MKLifeCycle.ts`

- 负责框架生命周期调度和清理，继承自 `mk.Layer`。
- 生命周期重点顺序：`create -> init -> open -> close -> lateClose`。
- `create`：节点展示前初始化视图。需要在展示前完成的 UI 初始化放这里。
- `init`：只有传入初始化数据时才调用，可重复调用，适合列表 item 或复用模块重置数据。
- `open`：不依赖初始化数据的打开逻辑，适合注册事件、使用子模块、初始化 UI。
- `close`：模块关闭时调用，适合停止定时器、缓动、运行中状态。
- `lateClose`：子模块也关闭后调用，框架会在这里执行自动清理。
- `initData` 可在子类中声明类型，`mk.uiManage.open(Component, { init })` 会得到类型检查。
- `data = new class { ... }()` 会在 `lateClose` 后自动重置，适合保存可复用 UI 的临时状态。
- 使用框架 `EventTarget` 或网络 message 监听时，把 target 传自身，`lateClose` 会自动解绑。
- `followRelease(obj)` 可让节点、资源、带 `release()` 的对象、函数、音频单元跟随模块释放。
- 父类自启函数不需要手动 `super.xxx()`；框架会按父函数再子函数的顺序调用。

### mk.SceneDrive

本地源码：`extensions/MKFramework/assets/MKFramework/Framework/Module/MKSceneDrive.ts`

- 场景加载完成后递归驱动场景上 `mk.LifeCycle` 的打开逻辑。
- 通过 `mk.bundle.loadScene` 切换场景前，会递归驱动关闭逻辑，保证模块清理。
- 非编辑器模式下会监听 `Director.EVENT_AFTER_SCENE_LAUNCH` 并自动挂载到场景子节点。
- 普通业务代码通常不直接继承它。

### mk.ViewBase

本地源码：`extensions/MKFramework/assets/MKFramework/Framework/Module/MKViewBase.ts`

- 动态 UI 视图基类，可由 `mk.uiManage` 注册、打开、关闭、复用。
- 支持视图展示配置：`isShowAlone`、`animationConfig`。
- `isShowAlone = true` 时，打开该视图会隐藏低层级已打开模块，关闭后恢复，适合全屏 UI 降低 DrawCall。
- `animationConfig` 配置打开/关闭动画，并可控制是否等待动画完成再进入子类 `open`。
- 支持编辑器快捷操作：`isAutoMask`、`isAutoWidget`、`isAutoBlockInput`。
- 外部调用 `module.close()` 会转交给 `mk.uiManage.close(module)`，适合作为按钮关闭回调。
- `typeStr` 用于同一脚本对应多个 UI 来源，例如 `default`、`shop`、`battle` 等。

### mk.StaticViewBase

本地源码：`extensions/MKFramework/assets/MKFramework/Framework/Module/MKStaticViewBase.ts`

- 静态视图基类，继承 `mk.LifeCycle`，但不由 `mk.uiManage` 管理。
- 适合场景入口、Canvas 常驻控制器、无需对象池/打开关闭管理的模块。
- 默认屏蔽 `mk.Layer` 功能；如果需要层级控制，在子类中定义：

```ts
protected _isUseLayer = true;
```

## UI 管理器 mk.uiManage

本地源码：`extensions/MKFramework/assets/MKFramework/Framework/MKUIManage.ts`

核心职责：

- 注册、取消注册、自动注册 UI 模块。
- 打开、关闭、获取 UI 模块。
- 内置对象池，减少 Prefab/Node 频繁创建销毁。
- 管理模块栈、重复打开保护、`isShowAlone` 隐藏恢复逻辑。
- 与全局重启事件联动清理资源与状态。

常用接口：

```ts
await mk.uiManage.regis(PanelClass, "Module/Panel/PanelClass", this, {
  loadConfig: { bundleStr: "resources" },
});

const panel = await mk.uiManage.open(PanelClass, {
  init: { id: 1 },
  type: "default",
});

await mk.uiManage.close(PanelClass);
await mk.uiManage.close(PanelClass, { isAll: true });
await mk.uiManage.close(PanelClass, { isDestroy: true, isDestroyChildren: true });
```

开发规则：

- 调 `open` 前先 `regis`；也可以实现 `mk.uiManage.getRegisDataFunc` 支持自动注册。
- `regis(source)` 可传 `Prefab`、资源路径、`Node`，或 `Record<type, Prefab | string | Node>`。
- `regis(target)` 优先传当前生命周期对象 `this`，这样资源和注册会跟随 target 自动释放。
- 默认 `isRepeat = false`，已有实例或正在打开时再次 `open` 会返回 `null`；列表 item 或多实例弹窗需要设 `isRepeat = true`。
- `poolInitFillNum` 会在注册时预填对象池，过大可能导致注册阶段卡顿。
- `close(isDestroy = false)` 默认回收到对象池；需要彻底销毁节点时显式传 `isDestroy: true`。
- 获取模块：

```ts
const last = mk.uiManage.get(PanelClass);
const list = mk.uiManage.get([PanelClass]);
const typed = mk.uiManage.get(PanelClass, "default");
const all = mk.uiManage.get();
```

## 框架功能地图

主要本地入口：

- UI 管理：`extensions/MKFramework/assets/MKFramework/Framework/MKUIManage.ts`
- 生命周期/UI 基类：`extensions/MKFramework/assets/MKFramework/Framework/Module/`
- 资源加载与释放：`extensions/MKFramework/assets/MKFramework/Framework/Resources/`
- 音频：`extensions/MKFramework/assets/MKFramework/Framework/Audio/`
- 多语言：`extensions/MKFramework/assets/MKFramework/Framework/Language/`
- 网络：`extensions/MKFramework/assets/MKFramework/Framework/Network/`
- 新手引导：`extensions/MKFramework/assets/MKFramework/Framework/Guide/`
- 任务：`extensions/MKFramework/assets/MKFramework/Framework/Task/`
- 数据、事件、日志、对象池等核心工具：`extensions/MKFramework/assets/MKFramework/Framework/`
- 组件工具：`extensions/MKFramework/assets/MKFramework/Framework/@Component/`
- 项目全局配置：`extensions/MKFramework/assets/MKFramework/Config/GlobalConfig.ts`
- 全局事件配置：`extensions/MKFramework/assets/MKFramework/Config/GlobalEvent.ts`

## 开发建议

- 新 UI 优先写成 `mk.ViewBase`，Prefab 根节点挂对应组件，然后由 `mk.uiManage.regis/open/close` 驱动。
- 场景入口脚本优先写成 `mk.StaticViewBase`，挂到场景 Canvas 或入口节点，使用 `open` 做启动逻辑。
- 需要初始化参数时，在 View 类中声明 `initData!:` 类型，再通过 `open(..., { init })` 传入。
- 可复用 UI 状态放 `data = new class { ... }()`，不要散落临时字段，方便关闭后自动重置。
- 事件、网络监听、资源引用尽量使用框架 target/followRelease 机制，少写手动清理。
- 做弹窗遮罩、全屏 Widget、阻断点击穿透时，优先使用 `ViewBase` 的编辑器快捷操作字段。
- 修改层级类型或窗口动画时，优先改 `GlobalConfig.View`，不要在业务脚本里分散硬编码。

## Avalon Demo 客户端入口

- 当前阿瓦隆 Demo 客户端的场景入口为 `assets/Scripts/App/AvalonDemoApp.ts`，挂载在 `assets/Main.scene` 的 `Canvas` 节点上。
- `AvalonDemoApp` 继承 `mk.StaticViewBase`，通过 `open` 构建运行时 UI，不依赖 prefab 引用；后续若要改成可视化 prefab，应保持协议/状态/网络层不变。
- 运行时 UI 覆盖连接、登录、加入房间、准备、座位选择、队伍提交、投票、任务、刺杀、结算日志与本地 5 人演示局。
- 本地 5 人演示局可在无服务端时推进完整流程：组队 -> 投票 -> 任务 -> 刺杀 -> 结算；联机模式仍优先走 WebSocket。
- 数据状态集中在 `assets/Scripts/Game/AvalonGameState.ts`；协议枚举、身份、阶段、任务人数矩阵集中在 `assets/Scripts/Game/AvalonGameTypes.ts`。
- WebSocket 封包集中在 `assets/Scripts/Network/AvalonProtocol.ts`，与 due 默认包格式保持一致：2 字节 little-endian seq + 2 字节 little-endian route + JSON body。
- WebSocket 生命周期和 route 分发集中在 `assets/Scripts/Network/AvalonNetwork.ts`；UI 不直接操作原生 `WebSocket`。

## TypeScript 本地联机服务

- 开发服务器位于仓库 `服务器端/AvalonTsServer`，使用 NestJS 11（platform-express + platform-ws），默认监听 `:8888`，`/health` 可查询运行状态。`compose.yaml` 一键启动 PostgreSQL、迁移与服务；数据库当前只保存玩家资料，`userId` 尚无正式鉴权；房间和对局仍是内存单实例实现。线上日志为 JSON stdout，Compose 配置 Docker 日志轮转。
- 服务端与 Cocos `AvalonNetwork` 使用相同的 2 字节 little-endian seq + 2 字节 little-endian route + JSON body 协议。
- `npm run test:smoke` 在独立端口启动服务并直接加载客户端 `AvalonNetwork`，验证 101 登录、102 加房、301 开局、303 身份和 302 阶段消息，可重复运行。
- 旧 Go Due 服务端仍在 `服务器端/Due_Server`，需要 Redis、etcd 和 gRPC；本地联调可先用 TypeScript 服务。
