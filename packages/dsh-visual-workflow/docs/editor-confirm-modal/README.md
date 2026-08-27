# 未保存关闭确认弹窗 · 真实界面证据

> 本次改动（`feat(workflow): replace native confirm with styled discard modal`）：
> 1. 未保存草稿关闭（Escape / 点击关闭 / 点击遮罩）弹出产品样式确认层（`.vwf-confirm-mask` +
>    `.vwf-confirm`），**不再调用浏览器原生 `confirm()`**；
> 2. 确认层横向 + 纵向居中（`position: fixed; inset: 0` flex 居中），圆角 14px、投影、深色适配；
> 3. 按钮：「我再想想」（保留草稿并留在编辑器）/「不改了」（丢弃草稿并关闭编辑器）；
>    点击遮罩空白 = 我再想想（不关闭）。

## 证据文件

| 文件 | 内容 |
| --- | --- |
| `confirm-modal.png` | 真实 Chromium 截图（1440×900）：编辑器上方弹出居中确认层 |
| `capture-metrics.json` | 程序化度量：`dialogRect` 中心 = 视口中心（居中 X/Y 误差 < 2px）、圆角/阴影、按钮文案、`confirmCalls: 0`、交互路径（我再想想/遮罩点击/不改了）全部通过 |

## 程序化验证

- jsdom 冒烟（`tests/client.smoke.mjs`）：Escape → 统一确认层（非原生 confirm，全程拦截
  `window.confirm` 并断言 0 调用）；「我再想想」保留编辑器；点击遮罩关闭确认层但编辑器
  保留；「不改了」关闭编辑器；干净状态直接关闭不弹窗。
- 真实 Chromium：`capture-metrics.json` 中 `passed: true`，确认层精确居中
  （left 521 / right 919 → 中心 720 = 1440/2；top 398.59 / bottom 501.39 → 中心 450 = 900/2）。
