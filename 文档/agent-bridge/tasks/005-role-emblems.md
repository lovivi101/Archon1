# 005 素材：五个角色徽记

- 类型：asset
- 输出（均为**新文件**，目录 `客户端/Godot_Client/assets/ui/`；开始前先确认这些文件不存在，若已存在则停止并在报告中说明）：
  - `role-percival.png` — 派西维尔（好人）
  - `role-morgana.png` — 莫甘娜（坏人）
  - `role-oberon.png` — 奥伯伦（坏人）
  - `role-mordred.png` — 莫德雷德（坏人）
  - `role-minion.png` — 莫德雷德的爪牙（坏人）
- 尺寸：每张 1254×1254，RGBA
- 背景：透明（四角 alpha 为 0）

## 用途

身份页（第 6 页）角色卡中央的身份徽记（显示宽约 300px），以及结算页每位玩家旁的小图标（显示宽约 48px）。现有同系列素材：`role-merlin.png`、`role-assassin.png`、`role-servant.png`。

## 风格（必须与现有三张一致）

先逐张查看 `role-merlin.png`、`role-assassin.png`、`role-servant.png`，严格匹配：

- 构图：一个**象征物**竖直居中，叠在一个带尖刺的暗色金属圆环徽章上，两侧垂挂破损的深蓝色布带；不是人物肖像。
- 材质：暗铁、做旧黄铜描边、细微划痕；冷色主光从左上方来。
- 留白：主体约占画布 80% 高度，四周透明留白。
- 阵营区分只用象征物的**点缀色**：好人用冷蓝/银色发光（参考梅林的冰蓝水晶），坏人用暗红/紫色发光。圆环与布带保持统一，这样五张和原有三张放在一起像一套。

## 各角色象征物

| 文件 | 象征物 | 点缀色 |
| --- | --- | --- |
| role-percival | 竖直的骑士长剑，护手处嵌一枚银色眼形宝石（象征能看见梅林） | 冷蓝/银 |
| role-morgana | 一面手持魔镜，镜中映出扭曲的冰蓝光（伪装成梅林） | 紫红 |
| role-oberon | 一顶破碎的角冠/鹿角头盔，缠绕荆棘（孤立、与同伴互不相识） | 暗紫 |
| role-mordred | 黑色王冠压在倒置的长剑上（对梅林隐藏的首领） | 暗红 |
| role-minion | 一把弯刃匕首与一截断链（服从的仆从） | 暗红 |

不要文字、字母、数字、水印、投影、地面。

## 验收

- 5 个文件存在，均为 1254×1254 RGBA，四角 alpha 为 0（用 Python PIL 检查并把结果写进报告）。
- 在 `客户端/Godot_Client` 运行 `E:\Game_Work\Godot\Godot_v4.7.2-stable_win64_console.exe --headless --path . --import`，无与这些文件相关的报错。
- 不修改任何代码、场景或已有素材（接入界面是任务 006）。
- 生成后把 8 张（新 5 张 + 原 3 张）拼成一张对比图保存到 `文档/agent-bridge/reports/005-role-emblems-contact.png`，便于审核一致性。

## 报告

写到 `文档/agent-bridge/reports/005-role-emblems.md`：每张的路径、尺寸、透明检查结果、生成提示词；自评与原三张的一致性，以及是否有需要重做的。不要提交 git。
