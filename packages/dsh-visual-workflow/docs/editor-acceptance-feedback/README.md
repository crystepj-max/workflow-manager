# 编辑器验收反馈（#3 锚点 / #4 把手）修复证据

针对整合验收版反馈的修复，逐项截图与度量（真实 Chromium，1440×900）：

## 1. 边起点固定三槽位（反馈 #3）

规则：起点锚点不再按边类数量均匀分布，改为固定 3 槽位——

| 槽位 | 位置 | 说明 |
| --- | --- | --- |
| 上槽 | 节点右边框上方 1/6 处（pad 8px） | 所有向上绕行边共享 |
| 中槽 | 节点右边框垂直居中 | 直连边专属；与连线源把手位置一致 |
| 下槽 | 节点右边框下方 1/6 处 | 所有向下绕行边共享 |

- 同类边共享槽位（不叠加偏移）；跨类严格 上 < 直连 < 下。
- 度量（`metrics.json`·anchors）：`start` 节点（x=56, y=64, w=220, h=66）——
  两条直连边起点同为 `cy=97`（= 64 + 66/2，节点右框垂直居中），下绕边 `cy=113.67`；
  `review` 节点上绕边 `cy=157.33` < 直连边 `cy=174`（= 该节点垂直居中）。
- 截图：`anchors-3slot.png`（开始=直连×2 共享 + 下绕；复核=上绕 + 直连）。

## 2. 连线把手默认隐藏、悬停高亮（反馈 #4）

- 默认：把手 `opacity:0; pointer-events:none`——无对应边的节点右侧不再出现灰色圆点
  （`metrics.json`·handles.defaultOpacity：9/9 均为 `0`）。
- 悬停：`g:hover > .vwf-handle` 显示，填充品牌色（`rgb(77,159,255)`）描边 3px + 光晕，
  与边起点圆点（同类槽位）视觉区分。
- 截图：`handle-default-hidden.png`（孤立节点无把手点）、`handle-hover-shown.png`
  （悬停开始节点：左右把手以品牌色高亮显示）。

## 3. 拖线目标高亮（反馈 #4）

- 拖线过程中 `pointermove` 命中目标节点 → 目标描边品牌色 + 加粗 3px + 光晕
  （`data-vwf-connect-target="true"`），抬起后按命中结果建边。
- 度量（`metrics.json`·connectTarget）：`highlighted=true, nodeId="isolate"`。
- 截图：`connect-target-highlight.png`（虚线预览 + 目标「孤立」节点高亮）。

## 冒烟测试覆盖

`tests/client.smoke.mjs`：
- 「防重叠」规则 5 断言升级：同类共享槽位（相等）＋跨类严格上升＋直连槽=节点右框垂直居中；
- 「拖拽连线」新增：拖线指向目标节点时存在 `[data-vwf-connect-target="true"]` 且为指向节点；
- 把手 CSS 断言：默认透明＋`g:hover` 显示。

## 运行验证

```
env -u DSH_HOME npm test            # 101 pass / 1 skip / 0 fail
env -u DSH_HOME npm run validate
```
