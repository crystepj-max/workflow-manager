# LOC-044 行为与抽取边界 V1

本文件与 [任务规格](task-spec-V1.md) 一起构成待确认 V1。目标是减少状态/恢复规则重复，同时保持公开行为；不按文件行数评价收益。

## 1. 已查明的职责边界

| 规则族 | 当前接入点 | 本任务拥有的部分 | 留在原层的部分 |
|---|---|---|---|
| 执行结果与生命周期 | `host.js` 的 canonicalStop/lifecycleFor 及结果归档调用方；生成器的终态结果 | 可共享的状态解释与完成/等待映射规则 | 引擎事件订阅、记录落盘、实际工作区状态写入 |
| 检查点 | `generate.mjs` 的 `[pw-ckpt]` 写出；host 的 extractCheckpoint/maybeAbortAtCheckpoint | 字段约定、有效入口判定、已解析载荷的规范化与恢复摘要构造 | 读取日志、截断日志、AbortController、监听和中断时机的副作用执行 |
| 人工等待与恢复 | 生成器 haltWaitingHuman、legacy gate resume；host 的 wf_run 恢复分支 | 相同字段的构造与兼容解释、可恢复类别/入口的纯判断 | 实际人工选择记录、外部授权、模型执行和专业裁决 |
| 暂停指导与基线回跳 | host 的 buildPauseResumeArgs | 已有规则下，从暂停摘要/指导/基线修订构造载荷 | Guidance/Revision 的写入、Proof失效范围和事务 |
| Blueprint 投影 | 已有 projection-core.cjs | 仅在共享模块接入需要时保持加载/投影兼容 | 不把投影内核改成运行引擎，不合并两种职责 |

此表是定位入口，**不是声称表内所有函数互相重复**。开工时必须以真实同义规则为单位记录重复位置；生产/消费互补逻辑只共用其字段契约，不强行共用所有代码。已经只有一处的规则继续复用。提交清单至少列：规则ID、原位置、唯一新所有者、所有调用方、前后行为凭证和未抽取理由。

源码入口：[generate](../../../../scripts/generate.mjs)、[host](../../../../packages/dsh-visual-workflow/src/host.js)、[projection](../../../../scripts/projection-core.cjs)。

## 2. 六类强制行为对照

每类至少一个主场景及表中异常变体。执行者在**修改前**从实际启动基线保存输入与期望输出，并记录 commit；不得以需求目标里的未来状态替代当前实现。

| ID | 输入事件/场景 | 必须比较的公开事实 | 边界变体 |
|---|---|---|---|
| S01 正常 | 一个合法结果顺序完成到 `$end` | canonical status、lifecycle、terminal、completion、结果与历史 | 迟到 workflow/end 不得覆盖已经确定的脚本终态，保持基线行为 |
| S02 返工 | 固定一次不通过→反馈→重做→通过 | 节点调用顺序、反馈、round/budget、已消费结果、恢复载荷 | 额度耗尽与显式追加预算按基线，不偷偷扩大上限 |
| S03 人工等待 | WAITING_HUMAN→合法决定→接续 | decision_id、选项、原专业结果、作用路径、人工记录 | 错误decision_id、非法choice、重复旧决定按既有拒绝方式处理 |
| S04 外部受阻 | 当前支持的模型探测失败→更新配置→同Run恢复 | BLOCKED原因、是否terminal、快照修订与Run身份 | 若已有LOC-030专业BLOCKED修复，增加其恢复样例；未合入时不伪称支持 |
| S05 暂停/取消 | safe pause在节点边界生效；interrupt中断当前attempt | PAUSED/取消的区分、恢复入口、已完成结果保留、额外调用 | 检查点后一节点已启动、末尾`$end`、正在取消时的迟到事件 |
| S06 旧快照 | 冻结旧脚本/字段载荷→读取并恢复 | 原脚本摘要、旧字段默认、历史/预算/指导、基线回跳 | 缺/损坏检查点、未知入口、缺Rev1入口、待生效基线修订 |

归一化仅限时间、随机ID、临时路径，使用一致映射保持引用关系。原因码、状态、顺序、入口、预算、结果和副作用请求不可整段忽略。既有问题另列已知缺陷及对应任务，不在这个重构里悄悄修正；已合入修复不能被对照基线回退。

## 3. 运行与交付检查

1. Node 直接运行纯逻辑对照，输入不可被修改；相同输入返回相同结果。
2. 生成真实脚本，通过既有 runtime harness/host 替身运行六类序列；测试以公开行为为准，不只检查函数名称是否移动。
3. 重新生成并验证；检查打包后模块引用全部可解析，生成脚本自包含，没有借闭包泄漏 Node/宿主对象。
4. 按项目真实安装验证门完成一次人工等待后恢复，记录 DSH 版本、实际安装路径、模板/脚本摘要、Run身份、决定和结果；若尚未获产品环境操作授权或环境不可用，单独标记 UNVERIFIED/BLOCKED。
5. 交付重复规则清单、前后差异报告、兼容说明和逐项AC。源码减行数量只可作附加信息，不是完成门槛。

可复用检查入口：[human-decision-runtime](../../../../scripts/test/human-decision-runtime.test.mjs)、[runtime-logical-run](../../../../scripts/test/runtime-logical-run.test.mjs)、[runtime-host](../../../../scripts/test/runtime-host.test.mjs)。具体新增测试位置由实现者按规则归属选择，不要求在本轮分析阶段写实现测试。
