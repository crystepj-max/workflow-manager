# 01 · DSL 类型定义与校验器

## 目标
定义可视化工作流 DSL 的 JSON 契约并实现校验器：结构合法（entry 存在、节点/边引用有效、边语义合法）+ 业务规则（同源同结果唯一出边、$end 可达、manual_check 与 output 互斥、max_attempts 正整数）。

## 产出
- `dsl` 契约文档（字段表：WorkflowDsl{version,id,entry,control{maxAttempts,maxRounds},nodes[worker],edges[{from,to,on}]}；Worker{id,provider,model,profile,goal,output{schema},successCondition,manualCheck,configOptions}；终态 $end）
- 校验器函数：`validateDsl(dsl) -> { ok, errors: [{nodeId|edgeIndex, message}] }`

## 验收
- 非法样本（未知节点引用 / entry 缺失 / 同源同结果重复出边 / 不可达 $end）各返回定位错误
- 合法样本（开发工作流 2.0 图）返回 0 错误

## 依赖
无
