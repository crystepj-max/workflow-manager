# 工作流插件主界面原型

状态：PROTOTYPE。本目录维护当前插件主界面的可运行副本，功能需求先在这里试用，再按确认范围进入正式实现。

本轮根据用户退回意见，替换了首版简化重绘：流程库、编辑器、图布局、节点配置、模型设置、运行详情和角色管理均来自正式客户端副本；宿主主题与设置面板尺寸也有来源记录。首版文件摘要相同只能证明来源未变，不能证明界面已经对齐，该结论已在 DESIGN.md 更正。

## 启动

使用 Node.js 24。在当前工作树根目录首次运行：

    npm install --prefix packages/dsh-visual-workflow/prototypes/main-ui --ignore-scripts --no-audit --no-fund
    node packages/dsh-visual-workflow/prototypes/main-ui/serve.mjs

打开 http://127.0.0.1:4179/ 。端口可通过 --port 4183 指定；只监听本机，production 模式拒绝启动。停止时按 Ctrl+C。

## 对照与试用

顶部工具条属于原型，插件内部保持正式组件的样式和布局。

| 入口 | 内容 | 用途 |
| --- | --- | --- |
| 当前原型（默认） | client.prototype.js + 内存宿主 | 修改和体验新需求 |
| 正式源码对照（source=current） | 直接读取 src/client.js + 同一内存宿主 | 与当前正式源码逐项对照 |
| 旧版原型（source=previous） | 原样读取 ui-workbench 第二轮 | 对照以前的完整业务场景与设计思路 |
| 390 px | 真实 390 × 844 的 iframe 视口 | 试验窄屏布局和窗格切换 |
| 深色 / 浅色 | 与 DSH 相同的主题属性和主题变量 | 核对控件、选中态和可读性 |

可分享的示例路径：

- 编辑器：/?theme=light&view=editor&workflow=wf-diagnose
- 运行列表：/?theme=light&view=runs
- 角色库：/?theme=light&view=roles
- 正式源码对照：/?source=current&theme=light&view=editor&workflow=wf-diagnose
- 窄屏：/?theme=light&view=editor&workflow=wf-diagnose&viewport=mobile

当前原型有一处显式试验差异 D1：修复应用与系统主题不一致时的选中态串色。正式源码对照保留当前源代码行为。可在 URL 加 system=light 或 system=dark 单独复现系统偏好，不修改系统设置。其余插件组件结构和样式沿用源码，差异记录见 [DESIGN.md](DESIGN.md)。

## 演示数据与边界

- 内置流程：读取当前 templates 的 4 套蓝图，通过正式 projectToVwf 映射成编辑器 DSL。
- 内置角色：读取正式角色清单与 12 份正文；中文文案、结果预设也直接读取正式文件。
- 5 套个人流程、2 个自定义角色、3 个空间、8 条任务、返工成果和模型选项为演示样例。
- 撤销、重做、保存、模型覆盖、角色修改、暂停与说明等交互只写当前页面内存；刷新恢复。
- 校验只调用本地只读内核。模型探针标明“未执行”，不会调用模型；未知宿主接口直接报错。
- 人工续跑等正式界面尚未开放的能力保持正式限制，不用假按钮声称执行成功。
- CSP 将连接限制为同源；没有真实 DSH 地址、凭据或运行引擎。

## 同步维护

先读 [AGENTS.md](AGENTS.md) 和 [HANDOFF.md](HANDOFF.md)。日常需求修改 client.prototype.js；演示接口与场景分别在 mock-host.js、seed.data.mjs，外壳在 app.css。客户端副本修改后刷新即可；服务端 seed.data.mjs / serve.mjs 修改后重启本原型服务。禁止在外壳 CSS 中重新实现插件的 .vwf-* 样式。

    node packages/dsh-visual-workflow/prototypes/main-ui/refresh-sync-baseline.mjs --check

检查会区分“正式来源漂移”和“原型含试验改动”，不把摘要匹配当成视觉验收。

正式源码变化后，先比较差异并更新原型。没有试验改动时可安全同步：

    node packages/dsh-visual-workflow/prototypes/main-ui/refresh-sync-baseline.mjs --sync-current-client --label "main@<完整 SHA>"

命令会保护已有试验改动，拒绝覆盖。本轮 D1 属于试验改动，因此同步时需先手工合并并复核。完成来源与界面对照后才记录新基线：

    node packages/dsh-visual-workflow/prototypes/main-ui/refresh-sync-baseline.mjs --accept-reviewed --label "main@<完整 SHA>"

宿主样式来源、版本和许可证见 [reference/SOURCE.md](reference/SOURCE.md)。本目录不自动访问其他仓库或更新宿主快照。

## 交接资料

- [DESIGN.md](DESIGN.md)：对比结论、唯一试验差异、当前证据与局限。
- [HANDOFF.md](HANDOFF.md)：文件归属、同步步骤、正式实施边界。
- [feature-handoff-template.md](feature-handoff-template.md)：下一项功能的原型交接模板。
- evidence/：新旧截图、源码对照截图和只读量测结果。

原型归档在独立分支 codex/prototype-main-ui；用户于 2026-10-21 授权提交并推送至 origin，实际交付版本以该分支的 Git 提交记录为准。正式 src/、蓝图、旧原型与原主工作区均不受本轮修改影响。
