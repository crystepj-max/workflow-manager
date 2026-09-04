# dsh-llm-account-auth

DSH 账户鉴权 LLM 适配器骨架：给宿主注册 `openai` / `anthropic` 两条 provider 路由，
**凭据取自各自 CLI 的本地登录态，设置 profile 里不写 API Key**。

对应诉求 A（「只是想用 OpenAI / Anthropic 账户鉴权的 LLM 做推理」）。
诉求 B（codex / cursor 作为**执行体** + 权限模式）不在本包范围内，按 ACP 协议远期实现。

## 目录

```
src/
  index.js        插件入口：apply(ctx) → llm.registerAdapter(['openai','anthropic'], adapter)
  profiles.js     provider 画像：端点 / 凭据来源 / 鉴权头 / 建议模型目录
  credentials.js  凭据解析：账户令牌 env → CLI 凭据库 → API Key env；账户 id 提取
  openai-jwt.js   从 ChatGPT OAuth JWT 载荷取 chatgpt_account_id（解析失败不抛错）
  adapter.js      LlmAdapter 实现（只有 stream() 是必须实现的抽象方法）
  wire-openai.js  OpenAI Chat Completions 线格式（API Key 模式）
  wire-openai-responses.js OpenAI Responses 线格式（ChatGPT 账户 / codex 后端）
  wire-anthropic.js Anthropic Messages 线格式
  sse.js          零依赖 SSE 解析
  blocks.js       块索引分配与累积 → StreamChunk 归一
tests/adapter.test.mjs  离线冒烟（桩 fetch，13 项，无需真实凭据）
```

## 当前覆盖范围

| provider | 模式 | 状态 |
|---|---|---|
| `anthropic` | API Key（`sk-ant-…`） | ✅ 可用 |
| `anthropic` | **账户（Claude 账号 OAuth）** | ✅ 可用（Bearer + `anthropic-beta: oauth-2025-04-20`） |
| `openai` | API Key（`sk-…`） | 不适用（此 profile 为**账户专用**，不退化到 `OPENAI_API_KEY`；纯 API Key / Chat Completions 模式需另立独立 provider） |
| `openai` | **账户（ChatGPT 账号令牌）** | ✅ 已实装并通过上机验证（Responses 线格式，codex 后端；GPT-5.4 实测正常回复）；账户 id 三级提取可用 |

`openaiWire()` 按凭据模式分发：API Key → Chat Completions（`api.openai.com`），
账户令牌 → Responses（`chatgpt.com/backend-api/codex/responses`）。

## 凭据解析优先级

1. `DSH_OPENAI_ACCOUNT_TOKEN` / `DSH_ANTHROPIC_ACCOUNT_TOKEN`（显式覆盖，测试与 CI 用）
2. CLI 本地凭据库（账户登录态，主路径）
   - OpenAI：`$CODEX_HOME/auth.json` 或 `~/.codex/auth.json`
   - Anthropic：`~/.claude/.credentials.json`、`~/.claude.json`
3. `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`（API Key 兜底）——**仅非账户专用 profile 生效**：
   OpenAI 账户模式为 `accountOnly`，跳过此兜底（codex 后端不接受 `OPENAI_API_KEY`，退化过去会报
   误导性的「API key is invalid」）；Anthropic 账户与 API Key 同端点，保留兜底。

令牌分类是启发式：命中 provider 的 `apiKeyPrefix`（`sk-` / `sk-ant-`）判为 API Key，
其余（JWT 等）判为账户令牌，据此选择鉴权头与端点。**例外**：凭据库条目可声明
`forceMode: 'account'` 跳过启发式——Claude 的 OAuth 令牌（`sk-ant-oat01-…`）也以
`sk-ant-` 开头，不声明会被误判成 API Key（本机已实测踩中并修复）。

**账户专用 profile（`accountOnly`）的双重守卫**：
- 第 3 路（API Key env 兜底）整体跳过——见上。
- 第 2 路（CLI 凭据库）读到的令牌**一律强制 account 模式**，不走 `classifyToken` 启发式。
  否则若 codex `auth.json` 里混有一枚 `sk-` 形令牌（含误把 `OPENAI_API_KEY` 当凭据读），
  会被降级成 API Key 去打官方 `api.openai.com`，报出误导性「API key is invalid」
  （本机实测踩中：退出登录后 `auth.json` 残留 `sk-` 形值即触发）。codex 凭据文件
  `keys` 已移除 `OPENAI_API_KEY`，只留 `tokens.access_token` / `tokens.id_token`。
三条路都取不到时抛 `LlmError` code `AUTH`（`accountOnly` 时第 3 路被跳过，
未登录即抛 AUTH 并引导 `codex login`，不会出现误导性 API Key 错误）。

### 账户 id（openai 账户模式必需）

codex 后端是 Cloudflare 前置的，缺账户 id 的请求会拿 403，与令牌是否有效无关。
三级来源，先到先得（见 `credentials.js` 的 `withAccountId`）：

1. env 覆盖：`DSH_OPENAI_CHATGPT_ACCOUNT_ID` / `CHATGPT_ACCOUNT_ID`
2. 凭据文档直存键：`tokens.account_id`（codex auth.json 实测存在）→ `account_id`
3. JWT 载荷 claim：`payload['https://api.openai.com/auth'].chatgpt_account_id`
   （优先已选令牌，再扫文档里其他 JWT）

取不到**不阻断请求**——宁可把请求发出去暴露真实的 403，也不在凭据阶段崩掉。

### OpenAI 账户模式的请求形态（codex 后端）

- 头部：`authorization: Bearer <令牌>`、`chatgpt-account-id`、`openai-beta: responses=experimental`、
  `originator: codex_cli_rs`、`session_id`（每次请求新的 UUID v4）
- 请求体：`store: false`（仅接受 stream:true + store:false）、`instructions` 必填非空
  （无 system 时用中性兜底）、`input` 必须是 item 数组、tools 扁平化 + `strict: false`
- 采样参数（`max_output_tokens` / `temperature` / `stop` …）**默认剔除**——codex 后端拒收；
  把端点指到官方 Responses 时用 `DSH_OPENAI_ACCOUNT_ALLOW_SAMPLING=1` 放行
- 事件流：块生命周期由 `response.output_item.added/done` 划定，`done` 携带权威完整值
  （覆盖增量累积，防截断）；usage 按 dsh-llm 互斥契约拆分（`input_tokens` 扣掉缓存命中）

### 环境变量一览

| 变量 | 作用 |
|---|---|
| `DSH_OPENAI_ACCOUNT_TOKEN` / `CODEX_ACCESS_TOKEN` | 账户令牌显式覆盖（测试与 CI） |
| `DSH_OPENAI_CHATGPT_ACCOUNT_ID` / `CHATGPT_ACCOUNT_ID` | 账户 id 显式覆盖 |
| `DSH_OPENAI_ACCOUNT_BASE_URL` / `DSH_OPENAI_ACCOUNT_PATH` | 覆盖 codex 端点（上机试错不改代码） |
| `DSH_OPENAI_ACCOUNT_ALLOW_SAMPLING` | `1` 时放行采样参数（非 codex 目标用） |
| `DSH_OPENAI_ACCOUNT_USER_AGENT` | UA 三档：`omit`（默认）/ `codex` / `dsh` |
| `DSH_ANTHROPIC_ACCOUNT_TOKEN` / `CLAUDE_ACCESS_TOKEN` | Anthropic 账户令牌覆盖 |
| `DSH_ACCOUNT_AUTH_PROXY` | **专用代理覆盖**（最高优先级）；企业内网出网到此代理 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 通用代理（大小写兼容）；未设 `DSH_ACCOUNT_AUTH_PROXY` 时生效 |

## 网络代理（企业内网必读）

Node 的全局 `fetch`（undici）**默认不读 `HTTPS_PROXY` 环境变量**，企业内网下会直连超时，
上层只看到笼统的 `fetch failed`（根因 `UND_ERR_CONNECT_TIMEOUT`）。本适配器在构造时检测
`DSH_ACCOUNT_AUTH_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY`，若存在则用 undici `ProxyAgent`
注入 fetch 的 `dispatcher`，**只代理本适配器的账户鉴权请求，不动 DSH 其他流量**。

- 代理必须是 **HTTP(S) CONNECT 代理**（如 Clash 的 mixed 端口），undici 不直接支持 SOCKS5。
- 实测（Windows / WeBank 内网）：Clash HTTP 代理在 `127.0.0.1:7890` 可出网到
  `chatgpt.com` / `api.openai.com`；沙箱自带代理（如 `127.0.0.1:52596`）不放行 OpenAI，会 502。
- 启动 DSH 时把代理传进环境即可：`HTTPS_PROXY=http://127.0.0.1:7890 dsh web`。
- 无代理环境（本机直连可达）不设这个变量，请求照常直连，不会被拦截。

## 接入核验清单（首次上机必做）

骨架里的凭据文件布局与账户模式头部是按常见形态预填的，**必须在本机核实后回填**：

- [x] ~~`codex login` 后，确认凭据文件真实路径与键名~~
      （Windows 侧已核验：`~/.codex/auth.json`，命中键 `tokens.access_token`，
      `tokens.account_id` 直存键存在，JWT claim 提取可用）
- [x] ~~`claude login` 后确认凭据落点~~
      （Windows 侧已核验：`~/.claude/.credentials.json#claudeAiOauth.accessToken` 存在；
      **macOS 上 Claude 可能主要存 Keychain**，文件形态未必存在——若取不到，
      需改走 `security find-generic-password` 读取，Mac 侧待办）
- [x] ~~Windows 侧发现并修复：Claude OAuth 令牌（`sk-ant-oat01-…`）被 `sk-ant-` 前缀
      误判为 API Key——已加凭据库条目 `forceMode: 'account'`~~
- [ ] 抓一次真实请求，确认 `anthropic-beta` 的当前值（骨架填 `oauth-2025-04-20`）
- [ ] **真实发起一次 OpenAI 账户模式请求**，核实头部集合：
      `originator: codex_cli_rs` 是否放行、`chatgpt-account-id` 大小写是否挑剔、
      User-Agent 三档（`omit`/`codex`/`dsh`，默认 omit）哪档能过 Cloudflare——
      opencode 记录说后端见不得第三方 UA，hermes-agent 却要求 `codex_cli_rs/` 前缀，说法矛盾
- [x] ~~模型 id 目录~~（用户 2026-09-03 核实 ChatGPT 账户模式可选：
      `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-5.4`；
      Anthropic：`claude-sonnet-5` / `claude-opus-5`）。目录为建议性，DSH 不因此拒绝未列出的 model id；
      **context（上下文窗口）仍故意留空**——未知容量不喂给宿主决策
- [ ] 网络代理：企业内网下 `HTTPS_PROXY` 必须指向可达 OpenAI 的 HTTP CONNECT 代理，否则报 `fetch failed`
      （已修复：适配器自动读 `HTTPS_PROXY` 并经 undici `ProxyAgent` 出网）

## 挂载

宿主注册后 `llm.listProviders()` 就会列出这两条路由——vwf 编辑器节点模型下拉的数据源即此
（`client.js` 的下拉项来自 `listProviders`，不是硬编码）。挂载方式参照同仓库
`packages/dsh-visual-workflow/cordis.patch.yml` 的 `dsh plugin add link:<绝对路径>` 模式。

随后蓝图里直接写即可：

```json
"bindings": { "models": {
  "dev":    { "provider": "openai",    "model": "gpt-5.6" },
  "review": { "provider": "anthropic", "model": "claude-opus-5" }
}}
```

改完 `npm run generate` 重生成（生成物禁手改）。

## 已知限制 / 下一步

- **OpenAI 账户模式头部集合已通过上机验证**：GPT-5.4 实测正常回复，确认
  `originator: codex_cli_rs` / `chatgpt-account-id` / `openai-beta: responses=experimental` /
  `session_id` 这套头能被 codex 后端接受（UA 默认 `omit` 档已验证可过）。
- **未调用 `registerConfigurableProviders`**：这两条路由靠 CLI 登录态激活，不经设置页配置，
  故未登记进可配置 provider 目录；若希望设置页显示 live/dormant 状态，再补该调用。
- **未填上下文窗口**：`resolveModel` 只回 `defaultMaxTokens`，context 保持未知。
- 账户令牌**过期/刷新**未处理：骨架每次调用重新读凭据文件，但不会主动 refresh
  （Windows 侧实测 `expiresAt` 字段存在；过期后续接 refresh_token 是下一步）。
- 诉求 B（执行体 + 权限模式）需先扩展蓝图 schema（per-node `executor`/`permissionMode`），
  再按 ACP 协议对接 codex / cursor——与本包是两条独立的轴。
- **网络代理已支持**（2026-09-03 修复 `fetch failed`）：适配器读 `HTTPS_PROXY`/`HTTP_PROXY`
  （或 `DSH_ACCOUNT_AUTH_PROXY`），经 undici `ProxyAgent` 注入 fetch dispatcher，只代理账户鉴权请求。
  企业内网启动 DSH 须 `HTTPS_PROXY=http://<可达 OpenAI 的 HTTP 代理> dsh web`。

## 测试

```bash
cd packages/dsh-llm-account-auth && npm test   # 13 项，桩 fetch，离线可跑
```
