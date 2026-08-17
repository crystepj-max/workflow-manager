# 需求分析：P2 · 持久化产品（issue #6）

> 生成方式：requirements-analysis 流程（inline 分诊 + L 型 wayfinder 路由）
> 需求源：https://github.com/crystepj-max/workflow-manager/issues/6
> 父任务：issue #3

## 分诊结论

- 类型：enhancement
- 状态：**needs-info**（存在需先决断的设计问题，不宜直接施工）
- 澄清：跳过逐条追问——歧义属于「设计决断」类，正是 L 型决策工单的对象；用户在会话中，后续工单认领时可再澄清
- 体量：**L**（路径不清晰 + 工作量超单会话）

## L 型判定依据

| 维度 | 证据 |
|---|---|
| 路径清晰度 | AiDynamic 的 DSH 映射无定论；workflowEngine 服务在本组合未挂载（P0 实测 pkg-4 曾卡 waiting）；workflow 引擎并发 cap 未验证；打包目标 profile 未确认 |
| 工作量 | 打包/持久化/AiDynamic/并行四块，明显超单会话 |
| 影响面 | 插件结构 + 宿主组合 + 存储层 + 引擎层 |

🔴 按硬规则：**L 型禁止整块开工**，先拆决策工单（见 decision-map.md），全部决断后出 OpenSpec → to-tickets。

## 三要素（当前态；验收标准含待决项）

### 任务目标
把可视化工作流插件从「动态原型」升级为「可安装产品」：用户 `dsh plugin add` 一次安装、重启仍在；用户工作流跨会话保留；可按需声明动态拆解节点；多个工作流实例并行运行互不串扰。

### 涉及范围
- 插件打包与安装形态（npm 组合包 / cordis.patch.yml / profile 安装）
- 模板与运行记录持久化（存储介质与 schema）
- DSL 新增 AiDynamic 节点（语义以 D1 决断为准）
- 多工作流并行（语义以 D4 决断为准）
- 执行链路正式化（D5：wf_run 从条件注册变必可用）
- **不做**：桌面客户端、跨机器同步、修改 harness 核心

### 验收标准（含待决标记）
1. 插件经 `dsh plugin add` 安装后重启会话仍在（目标 profile 见 D2）
2. 模板库跨会话保留可复用（存储介质见 D3）
3. AiDynamic 节点可执行并产出结构化结果（**待 D1 决断语义后细化**）
4. 两个工作流并行运行，状态互不串扰（**并行语义待 D4 决断后细化**）
5. wf_run 在所有目标环境可用（**路径待 D5 决断**）

## 决策地图

见 `decision-map.md`。五张决策工单（D1–D5）均为 issue #6 的子 issue：

| 工单 | 问题 | 阻塞的后续工作 |
|---|---|---|
| D1 | AiDynamic 节点在 DSH 的映射与取舍 | DSL 节点类型、编译器动态分支 |
| D2 | 组合包打包与分发形态 | 构建脚本、安装验证、README |
| D3 | 模板/运行记录持久化模型 | storageDomain vs 工作区文件、schema |
| D4 | 多工作流并行语义与边界 | 看板多 run UI、并发上限验证 |
| D5 | 执行链路正式化（workflowEngine 服务） | wf_run 必可用路径 |

## 缺口

无三要素缺口；验收标准 3/4/5 依赖决策工单输出后细化（已标注待决项）。
