# wf-explore 隔离文件交接（WFM-524）

本契约实现 Current 的研究材料传输，保留既有覆盖度判定、补充研究预算和输出 schema。真实节点生成报告、宿主成功发布、消费者可读副本是分别核验的状态。

## 版本与授权范围

新内置 `templates/wf-explore.json` 声明 `protocol.artifact_handoff="wf-explore/1"`。该声明连同完整 DSL 进入新 Run 的冻结快照。签发路由时，宿主对照随包分发的内置模板，比较包括固定 goal、节点、inputs、output、边、预算和协议在内的语义；仅模型绑定允许变化。仅使用相同 `id` 的自定义 DSL 不会获得这套隐式文件映射；修改 goal 的图即使保留版本声明也会被拒绝。产品验收刺激通过任务输入提供。

无此声明的旧 Frozen DSL / Run 继续原有显式文件行为。本实现不回写旧 Run、结果、history 或 Records。新版本需要新 Run。

## 具体交接内容

| 消费节点 | 宿主交接的当前材料 |
| --- | --- |
| `orchestrate` | 首轮无评价；后续仅前一阶段 `evaluation.md` 与完整 `evaluation.json`（含 `research_targets`） |
| `research` item | 仅自身任务书；宿主根据已发布计划和可信 item 序号绑定唯一 `expert_id`，不交接完整计划、兄弟报告或聚合 |
| `synthesize` | 当前计划 Markdown / 完整 JSON、各成功专家报告、完整 `research-aggregate.json`（失败项为 null，并附索引与原因） |
| `evaluate` | 当前计划、相同研究材料与聚合、当前 `synthesis.md` / 完整 `synthesis.json`（含 coverage） |

固定 Markdown 文件和结构化结果引用在模板中显式声明。当前文件 DSL 不支持动态数组文件或通配符；动态报告由此受限宿主映射解析为单个 literal `research-<expert_id>.md`，复用既有产物发布器。任意模型自报的路径都不成为来源。

`*.json` sidecar 的 `value` 是完整结果；外壳记录传输版本、真实生产身份及 `value_sha256`。`research-aggregate.json` 还保存成功/失败数量、位置不变的全部 items 和失败索引。它们只传输真实结果，`independent_proof=false`，不新增模型输出字段，也不产生独立 Proof。提示中的 2000 字符摘要仅供预览，正文从只读 sidecar 读取。

完整结果由冻结编译控制器放在 prompt 最末尾的固定传输框架中，绑定签发的 opaque route 对应 node / phase / call / item。宿主只解析该唯一尾框架并在启动模型前剥离；任务正文或 goal 中的伪标记不能替代它。允许的来源字段由四节点固定映射限定，不接收路径或任意 producer。消费者将非 null 项与当前成功 receipt 逐项核对；控制器因截止等原因丢弃为 null 的项仍为 null，即使 provider 曾完成/发布，也不交接其报告。尚无真实生产调用的失败位置保留空身份，不制造 attempt。

## 当前生产版本与隔离

控制器把已使用的业务补研额度 `budgetUsed` 作为传输阶段号（0/1/2），并传入调用序号。原有 `round`、history 和预算逻辑不变。宿主为每次实际调用另分配 invocation 身份；`research` 同时绑定当前计划的 invocation、item 序号和 `expert_id`。

宿主在正式 Run 目录的 `.handoff/<语义摘要>/round-<阶段>/<节点或item>/` 保存当前生产 slot 和不可变 attempt 文件副本。slot 从 `running` 变成 `ready` 前必须完成 schema、expert_id、必需文件、路径、普通文件、符号链接和 SHA-256 核验及发布；失败记录 `failed`。重试先替换当前 slot，旧成功报告不能冒充失败重试的材料。消费者仅接受当前阶段、当前计划及当前 item attempt 的版本；生产期间上游变化、字节损坏或未完成时拒绝。新宿主段可从这些记录恢复，不依赖前一段的内存 Map。

每次 provider 调用的实际 evidence 和 scratch 均按 item / invocation 分开。模型只访问自己的输出、scratch 和宿主为它复制的只读输入；消费者不获得 canonical、其他节点 evidence 或 workers 父目录的读取权限。宿主不扫描 evidence、不复制 scratch。符号链接检查与 exact 路径白名单沿用 `node-artifacts.mjs`。

这些 slot / sidecar 是传输依据，不能替代 Formal Records、业务覆盖检查、正式安装证据或真实产品验收。

## 验证边界

`scripts/test/explore-handoff.test.mjs` 覆盖原故障红检查、真实发布/完整消费、三阶段控制器链、控制器 null 与失败索引、传输入口伪标记/错身份/任意来源、缺文件/空文件/symlink、摘要损坏、跨阶段/旧 attempt、重试/新宿主段及 macOS Seatbelt 读写边界。行为测试使用受控模型输出；正式安装、新真实模型 Run 和产品 UAT 由交付负责人另行执行。
