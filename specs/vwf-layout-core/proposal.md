# OpenSpec 提案：vwf-layout-core

> 候选 3：客户端布局内核文件内模块化与直测
>
> 状态：架构 Spec v1（施工前评审稿）  
> 证据基线：`main` / `f3906f4`，2026-09-06  
> 依赖边界：候选 2 已完成；本提案不依赖候选 1，也不修改 Host 的投影链路。

## 1. 任务定义

### 1.1 目标

把客户端画布的图形布局从 React 渲染函数中抽成文件内的深模块（即：用一个小的几何接口隐藏分层、车道、起点槽位和标签避让），让布局规则可以脱离 DOM 直接验证，同时让 `Canvas` 只负责把布局结果显示为 SVG 和处理交互。

用户可观察的结果是：

- 工作流图继续保持当前的从左到右分层、节点不重叠、回退/跨节点边绕行和标签避让；
- 修改节点、边、入口或可见终点后，画布仍稳定重算；
- 后续修布局规则时，先能在纯几何测试中发现问题，不必等到完整编辑器渲染后才定位；
- 画布交互（选边、拖线、缩放、平移、定位问题节点）不被布局重构破坏。

### 1.2 范围

- 在 `packages/dsh-visual-workflow/src/client.js` 内建立独立的布局内核段，不新增运行时可导入文件；
- 收拢 `successTopologyOrder`、结构边/回退边判定、入口候选推导、回退车道、节点分层、边路线、起点槽位和边标签避让；
- 以 `layoutGraph(dsl, extraTerminals)` 为主要计算接口，返回 Canvas 所需的完整布局结果；
- 让 Canvas 删除标签避让循环和重复的路径几何判断，只保留 SVG 适配和事件处理；
- 保持客户端动态闭包的 plain JS 形态，不引入 `import/require`、React 依赖或 DOM 依赖到布局内核；
- 新增不依赖 jsdom 的直测加载器和布局测试，同时保留必要的客户端冒烟测试；
- 用有效 Blueprint/DSL 夹具对齐客户端入口候选语义与 `scripts/validate-core.cjs`。

### 1.3 明确不做

- 不把客户端布局抽成独立 ES module 或 `scripts/` 文件。客户端运行在浏览器动态闭包内，没有文件系统加载能力；
- 不改变用户可以看到的布局常量、颜色、字号、拖线业务规则或编辑器信息架构；
- 不把 SVG、React、`ctx.timeout`、Host RPC 或状态管理塞进布局内核；
- 不重新设计校验内核。`validate-core.cjs` 仍是业务结构校验权威；客户端只实现满足可视化所需的同构入口候选规则；
- 不把当前已经缩减为结构签名的 `useMemo` 依赖误改为“整个 DSL 序列化”。当前实现只序列化入口、节点 id、边结构字段和可见终点；候选 6 的性能治理另行处理；
- 不把画布渲染重写为新的 UI 框架或第三方图形库。

### 1.4 成功标准

1. 布局内核可在无 DOM、无 React、无 DSH 服务的环境直接调用；
2. `layoutGraph` 对当前有效图纸保持现有布局和路线不变量；
3. 边标签避让在内核输出中完成，Canvas 不再自行维护 `labelRects` 和无限让位循环；
4. 自环、脏边、回退边、业务结果边、平行边和额外终点不会造成死循环或崩溃；
5. 客户端入口候选推导与校验内核对有效输入保持一致；
6. 原有编辑器冒烟测试继续覆盖渲染和交互，新增直测覆盖布局算法；
7. 动态开发态和正式产品态都能从同一份 `src/client.js` 运行；机器通过不替代真实界面人工验收。

## 2. 当前事实与完整链路

### 2.1 当前布局内核

`client.js` 第约 559–830 行已经包含一组几乎纯函数的布局逻辑：

| 当前函数 | 当前职责 | 现状问题 |
|---|---|---|
| `hasOutcomeField` / `isStructuralEdge` / `isRollbackEdge` | 判断哪些边参与结构布局 | 客户端有一份，校验内核有相近规则 |
| `successTopologyOrder` | 入口优先、再按入度和剩余节点生成稳定顺序 | 只能随整段客户端闭包间接验证 |
| `deriveEntryCandidates` | 计算无结构入边节点并显示入口徽标 | 与校验内核有同类规则，未来容易漂移 |
| `computeBackwardLanes` | 给回退方向边分配上方车道序号 | 与路线计算耦合 |
| `computeEdgeRoutes` | 计算直连/上绕/下绕、端点槽位和路线参数 | 输出还不完整，标签位置由 Canvas 再算 |
| `layoutGraph` | 分层、节点位置、画布尺寸、路线和整体位移 | 是事实上的布局主接口，但没有直测接缝 |

当前 `Canvas`（约第 887–1240 行）还负责：

- 从 `layoutGraph` 结果重新计算每条边的 SVG 路径；
- 使用 `labelRects` 和 `while` 循环把标签从节点/已有标签上移开；
- 从位置结果推导命中节点、拖线目标和滚动定位。

其中最后一项是交互适配，应该保留；标签避让是几何布局规则，应下沉。

### 2.2 当前调用链

```text
Page
  └─ Editor
       ├─ normalizeEntry / deriveEntryCandidates → 入口徽标与 JSON 入口修正
       └─ Canvas
            ├─ useMemo(layoutGraph(dsl, visibleTerminals))
            ├─ pos / W / H → SVG 尺寸、节点位置、fitView
            ├─ routes + dsl.edges → SVG path / 标签 / 起点圆点
            └─ pos → 命中测试、拖线、滚动定位
```

当前 `useMemo` 的依赖是结构摘要：`entry`、节点 id、边的 `from/to/on/outcome/countRound` 和可见终点，不是整个 DSL。重构必须保留这个语义范围，不借本候选扩大为全量数据变更检测。

### 2.3 需要收敛的入口语义

`client.js::deriveEntryCandidates(dsl)` 与 `scripts/validate-core.cjs::deriveEntryCandidates(nodes, edges)` 都按以下业务规则工作：

- 结构边 = `on === 'success'` 或存在非空 `outcome`；
- 自环和带 `countRound` 的结构边视为回退边，不贡献入口入边；
- 指向 `$end`、`$human-decision` 或未知节点的边不贡献普通节点入边；
- 只有已知节点或 `$human-decision` 才可作为合法来源；
- 无结构入边的节点组成入口候选列表；
- 只有一个候选时，编辑器可自动归一 `dsl.entry`；多个候选由校验内核拒绝，显式 `entry` 不替代唯一性规则。

当前有效输入的主语义已接近一致，但两边是独立实现。直测阶段必须加入对拍夹具；如发现边界差异，以 `validate-core.cjs` 的结构校验契约为准修正客户端，不能让画布为通过校验的图纸显示另一套入口。

## 3. 目标设计

### 3.1 文件内模块与接缝

在 `client.js` 的插件返回体之前或明确标记的布局区内建立：

```js
function createVwfLayoutCore() {
  // 常量、结构边判定、拓扑、车道、路线、标签几何
  return {
    deriveEntryCandidates,
    layoutGraph,
  }
}
```

`apply(ctx)` 初始化时创建一次：

```js
const layoutCore = createVwfLayoutCore()
```

`Editor` 和 `Canvas` 只通过这个对象使用布局能力。生产运行时不暴露任何额外全局；测试通过明确的源码标记和 `new Function` 测试加载器取出 `createVwfLayoutCore`，这是测试适配器（即：只服务测试，不参与产品运行）的接缝。

### 3.2 外部接口

#### `layoutCore.layoutGraph(dsl, extraTerminals = [])`

返回：

```js
{
  pos: {
    [nodeId]: { x, y, w, h },
  },
  W,
  H,
  lanes: Map<edgeIndex, laneIndex>,
  routes: Map<edgeIndex, RoutePlan>,
  order: Map<nodeId, orderIndex>,
}
```

`RoutePlan` 的最小完整字段：

- 所有路线：`kind`、`yStart`、`yEnd`、`routed`；
- 直连路线：`parallelIndex`、`parallelCount`、`labelX`、`labelY`；
- 上绕/下绕路线：`laneY`、`channelStart`、`channelEnd`、`labelX`、`labelY`；
- `labelX/labelY` 必须已经避开节点和先前边标签，Canvas 不再二次移动。

接口不返回 React 元素、不读取 DOM、不修改 `dsl`，并保持边索引与输入 `dsl.edges` 一一对应。来源或目标未知的边不产生路线，但不应阻断其它合法节点的布局。

#### `layoutCore.deriveEntryCandidates(dsl)`

返回稳定顺序的节点 id 数组。它只负责可视化入口徽标和入口自动归一；正式保存和运行前的最终裁决仍由校验内核完成。

### 3.3 内部实现职责

以下函数可以继续存在，但必须隐藏在布局模块实现内，不作为调用方接口：

1. `hasOutcomeField`、`isStructuralEdge`、`isRollbackEdge`：结构边语义；
2. `successTopologyOrder`：入口优先、入度排序、剩余节点兜底；
3. `computeBackwardLanes`：回退边车道编号；
4. `computeEdgeRoutes`：直连/绕行、起点三槽位、平行边分离；
5. `placeEdgeLabels`：标签矩形检测与避让；
6. `layoutGraph`：分层、节点位置、画布尺寸、整体位移、最终路线输出。

### 3.4 标签避让下沉规则

当前 Canvas 中的以下逻辑必须移动到 `placeEdgeLabels`：

```text
初始 labelX / labelY
  → 与所有节点矩形比较
  → 与已经放置的标签矩形比较
  → 冲突时沿垂直方向按 EDGE_LABEL_H 让位
  → 写回 RoutePlan.labelX / labelY
```

要求：

- 处理顺序保持输入边顺序，避免同一图出现随机标签位置；
- 节点矩形使用最终整体位移后的 `pos`；
- 所有有效边必须有标签位置；
- 自环和未知边不能导致无限循环；
- 标签宽高仍使用当前固定 `EDGE_LABEL_W/EDGE_LABEL_H`，本候选不改文案排版；
- Canvas 只读取 `route.labelX/labelY` 并绘制文字。

### 3.5 Canvas 的保留职责

重构后 Canvas 仍负责：

- 将 `RoutePlan` 转换成 SVG `d` 字符串；这是一层很薄的显示适配，不再决定绕行类别或标签避让；
- 使用 `pos` 渲染节点、状态色、入口徽标和连接把手；
- 处理点击、拖线、右键菜单、缩放、平移和滚动定位；
- 通过 `W/H` 计算 fitView；
- 将 `layoutCore` 的结果与 `dsl` 的业务文案拼成 DOM/SVG。

## 4. 测试接缝与测试策略

### 4.1 直测加载器

新增 `packages/dsh-visual-workflow/tests/helpers/load-client-layout.mjs`：

1. 读取当前 `src/client.js`；
2. 通过 `VWF_LAYOUT_CORE_BEGIN` / `VWF_LAYOUT_CORE_END` 明确标记提取布局区；
3. 使用 `new Function(coreSource + '\\nreturn createVwfLayoutCore()')` 生成测试对象；
4. 如果标记缺失、函数未返回或输出接口不完整，测试立即失败。

该加载器不启动 React、不创建 DOM、不注册 slots，测试的是布局模块自己的接口，而不是源码字符串内部细节。生产代码不能因为测试加载器而增加业务分支。

### 4.2 布局内核直测

新增 `packages/dsh-visual-workflow/tests/layout-core.test.mjs`，至少覆盖：

| 场景 | 断言 |
|---|---|
| 单节点/线性链 | 层级从左到右，节点矩形无重叠，尺寸和边距稳定 |
| 入口变化 | `entry` 改变后顺序和垂直位置按当前规则变化 |
| 业务结果边 | 非回退 `outcome` 边参与结构分层；带 `countRound` 的回退边不拉长主链 |
| 跨节点边 | 产生下绕路线，路线不穿过中间节点 |
| 回退/失败边 | 产生上绕路线，终点保持目标左框垂直居中 |
| 平行边 | 起点槽位类别稳定，曲线分离参数不同，标签不重叠 |
| 标签冲突 | 结果中的 `labelX/labelY` 不与节点或已放置标签矩形重叠 |
| 自环/循环脏数据 | 在有限时间内返回，不死循环；合法边仍有可渲染路线 |
| 额外终点 | 终点去重并使用终点尺寸，不污染普通节点顺序 |
| 未知端点 | 忽略无效路线，不影响其它合法位置 |
| 入口对拍 | 有效夹具中与 `validate-core.cjs` 的入口候选一致 |
| 输入不变 | 调用前后 DSL 深度相等 |

### 4.3 客户端冒烟测试保留范围

`client.smoke.mjs` 不删除；它改为验证布局接线和用户操作：

- SVG 节点、边、标签仍渲染；
- 跨节点/回退边存在可见路线；
- 点击边仍能选中并显示配置面板；
- 拖线、缩放、平移、fitView 和滚动定位仍可用；
- JSON 修改入口、节点和边后，Canvas 使用新布局；
- 画布不因新接缝出现异常空白或 React 报错。

算法级的每个坐标、车道序号和标签矩形断言迁移到 `layout-core.test.mjs`。这是“替换而不是叠加”：避免同一套几何规则同时被 DOM 测试和纯函数测试维护两份脆弱断言。

## 5. 施工分阶段与验证

### 阶段 A：建立行为基线

动作：从现有 `client.smoke.mjs` 提炼复杂图、入口变化、自环和业务结果边夹具；记录当前路线类型、端点中心、起点槽位和标签避让结果。  
验证：当前依赖安装后，基线冒烟通过；若环境缺依赖，只能标记 `INCOMPLETE`，不能宣布基线绿。

### 阶段 B：抽出布局模块，不改输出

动作：移动纯函数和常量，建立 `createVwfLayoutCore`；`Editor/Canvas` 改为使用 `layoutCore`。  
验证：新增直测覆盖表格中的不变量；客户端冒烟的 SVG 结果与基线一致。

### 阶段 C：下沉标签避让

动作：把 Canvas 的 `labelRects`/`while` 循环移入布局内核，RoutePlan 返回最终标签位置。  
验证：复杂图的标签不覆盖中间节点、彼此不完全重叠；Canvas 不再包含标签碰撞决策。

### 阶段 D：入口语义对拍与收口

动作：为客户端和 `validate-core` 建立相同有效夹具；只在对拍失败时修正客户端实现；更新注释说明“校验内核权威、布局内核负责可视化”。  
验证：根测试、包测试、完整校验通过；最后执行真实产品模式界面检查。

## 6. 验收测试矩阵

| 层级 | 必测行为 | 证据位置 |
|---|---|---|
| 布局内核 | 分层、路线、车道、槽位、标签避让、循环防护、输入不变 | `tests/layout-core.test.mjs` |
| 入口对拍 | 有效图纸的候选入口与校验内核一致 | `tests/layout-core.test.mjs` + `scripts/test/validate-*.test.mjs` |
| Canvas 接线 | 读取完整 RoutePlan，不自行避让标签 | `tests/client.smoke.mjs` |
| 交互 | 点选、拖线、右键添加终点、缩放、平移、fitView、定位问题节点 | `tests/client.smoke.mjs` |
| 动态/静态包 | 同一 `src/client.js` 生成的开发态和正式态可运行 | `static-bundle.test.mjs` / `dist-fresh.test.mjs` |
| 项目闸门 | 生成、核心测试、包测试、完整校验 | `npm run generate`、`npm test`、`npm run validate` |
| 视觉人工验收 | 宽屏、窄屏、回退环、业务结果边、标签密集图 | 产品 DSH 截图/录屏与人工签字 |

### 必须保留的视觉不变量

1. 节点宽高仍为当前 220×66，终点仍使用当前终点尺寸；
2. 前向跨节点边走下方外围车道，回退/失败方向边走上方外围车道；
3. 目标节点的边终点落在左框垂直中心；
4. 同一来源的上绕、直连、下绕起点槽位顺序不倒置；
5. 平行边不会完全重合，前一条边仍可点击；
6. 标签不覆盖节点、不与已放置标签完全重叠；
7. 自环不会阻塞首屏渲染；
8. 入口徽标与入口归一行为不改变。

## 7. 关键决策与替代方案

### 🔴 决策：采用文件内纯布局模块，使用测试专用源码接缝

| 方案 | 成本 | 收益 | 风险 |
|---|---|---|---|
| A. 文件内 `createVwfLayoutCore` + 直测（推荐） | 调整 `client.js` 内部组织，新增测试加载器和直测；不改变发布形态 | 保持动态闭包约束；布局直接可测；Canvas 变薄，修改局部集中 | 测试加载器依赖明确源码标记；施工时需防止闭包作用域变化 |
| B. 新增浏览器模块文件并在 client import | 需要改动态加载器、正式包和开发态加载协议 | 文件边界最清楚 | 当前客户端没有可靠模块加载缝；开发态/正式态双轨都要改，风险远大于收益 |
| C. 保留布局在 Canvas，只增加 jsdom 断言 | 改动少 | 短期覆盖率增加 | 仍无法直测纯算法；DOM 断言慢且难定位；后续规则修改继续牵动渲染层 |

推荐 A，因为它把产品约束（不能新增浏览器模块）和工程收益（直测、局部性）同时满足。

## 8. 风险、回滚与非目标

### 🟡 风险

- 将标签避让从渲染循环移入内核时，若先后顺序或最终位移时机变化，密集图会出现视觉漂移；必须保留复杂图基线并做人工截图；
- 动态客户端闭包对词法作用域敏感，`createVwfLayoutCore`、常量和 `END_NODE` 的移动要以客户端冒烟和静态 bundle 共同验证；
- 对拍测试若只覆盖理想图纸，会漏掉未知端点、继承字段、重复节点等边界；有效输入和防御性脏输入必须分开写；
- `jsdom` 能证明 DOM 结构和交互接线，不能证明真实浏览器中的缩放、字体和滚动视觉；
- 当前 `useMemo` 依赖已经是结构摘要，若顺手扩成全 DSL 依赖，会把候选 6 混入本任务并扩大回归面。

### 回滚

如果产品模式视觉验收失败，当前候选版本立即失效：回到开发态修改 `src/client.js`，重新执行生成、包构建、完整校验和产品验收。禁止手改 `dist/client.js` 或沿用旧截图。

### 非目标

本 Spec 不决定未来的自动布局算法（例如新的排序、紧凑布局或可拖拽节点）；它只把当前已接受的布局行为放到可验证的接缝后面。若要改变布局体验，应另建产品/视觉规格。

## 9. 预计改动清单

| 路径 | 变更 |
|---|---|
| `packages/dsh-visual-workflow/src/client.js` | 新增文件内布局内核段；Canvas 消费完整 RoutePlan；移除渲染层标签避让决策 |
| `packages/dsh-visual-workflow/tests/helpers/load-client-layout.mjs` | 新增布局内核测试加载器 |
| `packages/dsh-visual-workflow/tests/layout-core.test.mjs` | 新增无 DOM 直测 |
| `packages/dsh-visual-workflow/tests/client.smoke.mjs` | 保留交互/接线断言，迁移算法级断言 |
| `scripts/validate-core.cjs` 或其测试 | 仅在入口对拍发现真实差异时修正；默认不改校验规则 |
| `docs/design/plugin-layer.md`、`CONTEXT.md` | 记录布局内核接缝和“校验权威/布局适配”分工 |

## 10. Definition Check

- [x] 目标、范围、非目标和用户可观察结果明确；
- [x] 当前布局链路从编辑器入口到 SVG/交互输出已闭合；
- [x] 布局接口、输出字段和不变量已定义；
- [x] 标签避让的责任归属已明确；
- [x] 自动测试、DOM 冒烟和真实视觉验收已分层；
- [x] 客户端动态闭包与正式包约束已纳入；
- [x] 当前没有需要改变产品行为的未决事项；
- [ ] 施工前仍需人工确认是否按本 Spec 建立实现任务/分支。本文件本身不代表已施工或已发布。
