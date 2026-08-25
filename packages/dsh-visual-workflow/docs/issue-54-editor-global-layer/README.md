# issue-54 编辑器全局层 · 真实界面验收证据

> 依据 `AGENTS.md`（「修改可视化编辑器时，应附上截图或录屏」）与评审 P2 补充。
> 本次 `feat/issue-54-editor-global-layer` 把编辑器宿主从「设置页右侧大抽屉」改为
> **原生顶层 `<dialog>` 编辑工作区**，目的是摆脱祖先 `transform` / `overflow` 等
> 皮肤布局对 `position:fixed` 元素的裁切。以下用真实 Chromium 渲染实际客户端半
> （`src/client.js` + 其注入的 CSS），在**深色/浅色皮肤**与**三种窗口尺寸**下核验
> 顶层 `<dialog>` 不被裁切且保持居中，并留下截图。

## 截图清单

| 文件 | 皮肤 | 视口 | 结论 |
| --- | --- | --- | --- |
| `dark-desktop.png` | 深色（默认） | 1440×900 | 居中、无裁切 |
| `dark-laptop.png` | 深色（默认） | 1280×800 | 居中、无裁切 |
| `dark-narrow.png` | 深色（默认） | 1024×768 | 居中、无裁切 |
| `light-desktop.png` | 浅色（compat） | 1440×900 | 居中、无裁切，浅色皮肤生效 |

`capture-metrics.json` 为每次会话的程序化度量，全部满足：

- `dialogPresent` / `dialogOpen`：顶层 `<dialog>` 已打开并进入 top layer；
- `fitsViewport`：对话框包围盒完整落在视口内（`left≥0`、`top≥0`、`right≤innerWidth`、`bottom≤innerHeight`）；
- `centered`：水平居中偏差 < 3px；
- `noPageHScroll`：页面无横向溢出（无被页面级滚动裁切）；
- `bodyScrollable.w === bodyScrollable.cw`：编辑区无横向溢出，纵向内容经 `.vwf-editor-body` 滚动而非被裁切。

度量结果：`passed = true`（4/4 会话全部通过）。

## 产出方式（可复现）

使用的宿主与 `tests/client.smoke.mjs` 运行时同构（注入 `styles` / `host` / `slots`
+ React），仅把 JSDOM 换成真实 Chromium（Playwright）。捕获脚本与依赖保留在
`.scratch/pw-env/`（已被 Git 忽略），其步骤为：加载 `src/client.js` → 用
`--dsw-alias-*` 皮肤变量覆盖 `:root` → 渲染模板库 → 点「编辑」打开顶层
`<dialog>` → 采集 `getBoundingClientRect` 与页面/编辑区滚动度量 → 截图。

> 说明：此独立宿主用真实浏览器验证顶层 dialog 与响应式布局在不同窗口尺寸与
> 皮肤下的无裁切表现；真实 DSH 应用会额外叠加 shell 的祖先布局，本证据用于证明
> 该改动所针对的「设置页祖先裁切」已通过 top-layer 方案消除。
