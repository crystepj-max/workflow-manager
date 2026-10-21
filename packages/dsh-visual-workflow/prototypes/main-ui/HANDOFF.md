# 原型维护与实施交接

## 文件归属

| 文件 | 责任 |
| --- | --- |
| client.prototype.js | 正式客户端副本，日常功能试验的主要修改处；当前只有 D1 显式差异 |
| runtime.js | 为客户端注册设置页、计时器、主题与内存宿主 |
| mock-host.js | 模型覆盖、草稿、角色、运行控制的内存接口；未知接口失败 |
| seed.data.mjs | 读取真实蓝图 / 角色 / 文案 / 预设，构造明确标记的演示场景 |
| serve.mjs | 本机服务、候选与正式源码打包、只读校验、旧稿对照；不调用真实 DSH |
| app.css、frame.html | 宿主承载外壳，不重写插件样式 |
| index.html、app.js、shell.css | 预览工具条、版本对照、主题和视口 |
| reference/ | 有版本和许可记录的宿主主题快照 |
| refresh-sync-baseline.mjs、sync-baseline.json | 来源漂移检查与受保护的同步 |

## 当前正式映射

| 用户路径 | 正式组件 | 真实能力依赖 |
| --- | --- | --- |
| 流程库与编辑工作区 | Page、Editor、StepNavigator、Canvas、NodeInspector | vwf.workflows.*、vwf.validate、vwf.outcomePresets.list |
| 逐节点模型覆盖 | Page 中的 ovRows、openOv、saveOv | vwf.workflows.modelOverride.*、vwf.models |
| 多空间运行列表 | Dashboard | vwf.runs.list、vwf.logicalRuns.get |
| 结果、版本、返工、完整经过 | RunDetail | vwf.records.list、vwf.state、vwf.logicalRuns.get |
| 运行控制 | RunDetail | vwf.run.control；原型只模拟 pause / interrupt / guidance |
| 角色管理与正文 | RoleManager | vwf.roles、vwf.roles.get / usage / validate / create / update / remove |

位置均在 packages/dsh-visual-workflow/src/client.js；协议边界查 src/host.js。以当前函数名定位，不依赖易漂移的行号。

## 一项新需求如何推进

1. 说明要解决的用户问题、当前行为、预期行为和非目标；记录正式基线与所用场景。
2. 在 client.prototype.js 实现体验；需要更多状态时修改 mock-host.js / seed.data.mjs。禁止修改真实服务配置或转发接口。
3. 在“当前原型”中实际操作，同时打开“正式源码对照”核对没有要求改变的区域；需要时对照旧版完整场景。
4. 将每个主动差异追加到 DESIGN.md，记录操作、主题、视口、结果、截图和仍未知的部分。
5. 交付具体可评审版本。正式实施须获得覆盖设计和文件范围的用户授权；原型中的选择不自动构成提交、推送或合并授权。

## 正式来源更新

先运行 refresh-sync-baseline.mjs --check，再查看正式差异、合并到客户端副本并复核。--sync-current-client 在副本有试验改动时拒绝覆盖，当前 D1 必须被显式保留或处理。

--accept-reviewed 只记录来源摘要，不能证明界面一致。记录基线之前应完成相同数据、相同视口的正式源码渲染对照。宿主快照更新时同步 reference/SOURCE.md 的版本和截图。

## 转入正式实施

使用 feature-handoff-template.md，写明已审阅的原型版本、用户原话、选定差异、正式文件范围、验收路径和检查。当前副本不能整份覆盖生产文件；应将获准差异作为小补丁在独立实施分支重做，并完成项目要求的审查和验证。

交接时以 codex/prototype-main-ui 上实际包含本目录的提交 SHA 绑定 branch@commit 证据，不能使用分支起点的基线 SHA 代替原型版本。用户于 2026-10-21 授权提交和推送本轮原型，这不代替正式实施的范围确认。真实 RPC、模型、安装和产品验收必须单独记录，不能由原型演示代替。
