# Repository Guidelines（仓库指南）

## 项目结构与模块组织

- `templates/` 存放工作流蓝图，是项目唯一的事实来源。
- `scripts/` 存放生成、校验、运行排练和测试相关内容。
- `packages/dsh-visual-workflow/` 存放可视化工作流插件：`src/` 为运行内容，`tests/` 为测试，`docs/` 为迁移说明。
- `dsh/` 存放角色说明、技能和安装脚本。
- `docs/design/` 与 `docs/research/` 存放设计契约和研究资料；`wayfinder/` 存放决策与任务记录。
- `.generated/` 是自动生成的结果目录，已被 Git 忽略。禁止直接修改；应先修改蓝图，再重新生成。

## 构建、测试与开发命令

以下命令均在仓库根目录执行：

```bash
npm run generate   # 根据 templates/*.json 重新生成结果
npm test           # 运行核心与运行流程测试
npm run validate   # 校验蓝图、生成结果一致性和插件包测试
```

如需单独测试可视化工作流插件，先安装测试依赖，再运行专项测试：

```bash
cd packages/dsh-visual-workflow
npm install --cache <本地缓存目录>
npm test
```

## 编码风格与命名约定

使用两个空格缩进，JavaScript 采用当前文件已有的模块写法，并保持周边代码风格。JSON 使用两个空格缩进。标识符使用清晰的小写命名，例如 `dev-workflow-2-0`；测试文件按被测试行为命名，例如 `runtime-host.test.mjs`。仓库没有统一的格式化或规范检查工具，因此应运行校验命令，并将改动严格限制在任务范围内。

## 测试指南

测试使用仓库现有的 Node 测试工具：单元测试和集成测试使用 `*.test.mjs`，客户端冒烟测试使用 `*.smoke.mjs`。可复用的输入案例放在 `scripts/test/fixtures/`。每次修改蓝图或生成规则后，都应运行 `npm run generate` 和 `npm run validate`；如果尚未检查生成结果一致性，不应仅凭单元测试通过就宣布完成。

## 提交与合并请求指南

提交信息使用项目历史中已有的简洁前缀：`feat:`、`fix:`、`docs:`；必要时添加范围，例如 `feat(workflow): ...`。每次提交只处理一个清晰主题。合并请求应说明对用户或工作流程的影响，列出已运行的校验命令，说明蓝图或生成结果是否受到影响，并关联对应任务或问题。修改可视化编辑器时，应附上截图或录屏。

## 配置与安全

不要提交凭据、本地 DSH 状态、`.agent-runs/`、`.scratch/`、`node_modules/` 或自动生成的结果。出现不一致时，以 `templates/` 和已记录的项目契约为准。
