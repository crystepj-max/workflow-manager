# 边锚点规则 5/6 · 真实界面证据

> 本次改动（`fix(workflow): anchor edge endpoints at node-left vertical center`）：
> 1. 起点锚点：同一源节点多条边按「上绕 / 直连 / 下绕」在右边框内自上而下间隔；
> 2. 终点锚点：所有边统一落在目标节点**左边框垂直居中**，不再按类别做目标锚点间隔（规则 6）；
> 3. 布局对自环边（`from === to`，脏数据防御）跳过 rank 最长路计算，避免 rank 无限自增。

## 证据文件

| 文件 | 内容 |
| --- | --- |
| `edge-anchors.png` | 真实 Chromium 画布截图（1440×900）：开始→汇总×2、开始→复核（下绕）、复核→汇总（上绕/红色失败）、开始→结束 |
| `capture-metrics.json` | 程序化度量：每条边 `yEndPath` 与目标中心 `yEndTarget` 相等（误差 < 0.5）；各源节点起点按 up→direct→down 严格递增且同一右边框 |

## 程序化验证

- jsdom 冒烟（`tests/client.smoke.mjs`）：**防重叠** 用例按 dsl 数据驱动断言——每条边终点
  = 目标节点实测中心（高度取自 DOM rect），同源起点按 上绕→直连→下绕 自上而下间隔；
  另有 **自环边** 用例：布局不进入死循环、自环边终点仍在节点左边框垂直居中。
- 真实 Chromium：`capture-metrics.json` 中 `passed: true`，全部边终点居中误差 < 0.5px，
  起点排序单调、同边框、与边同色。
