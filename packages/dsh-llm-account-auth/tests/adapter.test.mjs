// 离线冒烟：用桩 fetch 验证 StreamChunk 协议与鉴权头，不依赖真实凭据与网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountAuthLlmAdapter } from '../src/adapter.js';
import { resolveCredential, classifyToken } from '../src/credentials.js';
import { PROFILES } from '../src/profiles.js';
import { responsesRequest } from '../src/wire-openai-responses.js';
import { apply } from '../src/index.js';

const JWT_CLAIM = 'https://api.openai.com/auth';

/** 造一枚带指定载荷的 JWT 形状令牌（签名段不校验，仅走解析路径）。 */
function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

/** 把 SSE 帧数组变成 Response 形状的桩。 */
function sseResponse(frames, { tail = 'data: [DONE]\n\n' } = {}) {
  const text =
    frames.map((f) => `event: ${f.event ?? 'message'}\ndata: ${JSON.stringify(f.data)}\n\n`).join('') +
    tail;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body, text: async () => text };
}

async function collect(gen) {
  const out = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

const BASE = {
  provider: 'openai',
  model: 'gpt-5.6',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

test('openai · API Key 模式产出规范的文本块流', async () => {
  let seen;
  const adapter = new AccountAuthLlmAdapter({
    env: { OPENAI_API_KEY: 'sk-test' },
    resolveCredential: async () => ({ mode: 'api-key', token: 'sk-test', source: 'test' }),
    fetch: async (url, init) => {
      seen = { url, init };
      return sseResponse([
        { data: { choices: [{ delta: { role: 'assistant', content: '你好' } }] } },
        { data: { choices: [{ delta: { content: '世界' } }] } },
        { data: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
        {
          data: {
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } },
          },
        },
      ]);
    },
  });

  const chunks = await collect(adapter.stream({ ...BASE }));

  assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer sk-test');
  assert.ok(seen.init.headers['user-agent'], '每个 provider 请求都必须带归属头');

  assert.deepEqual(
    chunks.map((c) => c.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  );
  // counts 互斥契约：prompt_tokens 含缓存命中，扣掉 cached 后单报 inputTokens。
  assert.deepEqual(chunks.at(-2).usage, { inputTokens: 8, outputTokens: 7, cacheReadTokens: 3 });
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
  assert.deepEqual(chunks[3].block, { type: 'text', text: '你好世界' });
});

test('openai · 账户模式（Responses）文本流：严格 codex 头 + 权威值覆盖 + 互斥 usage', async () => {
  let seen;
  const adapter = new AccountAuthLlmAdapter({
    env: {},
    resolveCredential: async () => ({ mode: 'account', token: 'jwt-token', accountId: 'acct_test', source: 'test' }),
    fetch: async (url, init) => {
      seen = { url, init };
      return sseResponse([
        { event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message', role: 'assistant' } } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_1', delta: '你好' } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_1', delta: '世界' } },
        // done 事件携带权威全文（比增量更长）：应覆盖增量累积，防截断。
        { event: 'response.output_item.done', data: { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: '你好世界！' }] } } },
        { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11, input_tokens_details: { cached_tokens: 3 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 4 } } } } },
      ]);
    },
  });

  const chunks = await collect(adapter.stream({ ...BASE }));

  assert.equal(seen.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(seen.init.headers.authorization, 'Bearer jwt-token');
  assert.equal(seen.init.headers['chatgpt-account-id'], 'acct_test');
  assert.equal(seen.init.headers.originator, 'codex_cli_rs');
  assert.equal(seen.init.headers['openai-beta'], 'responses=experimental');
  assert.match(
    seen.init.headers.session_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'session_id 是每次请求新生成的 UUID v4',
  );
  assert.equal(seen.init.headers['user-agent'], undefined, 'UA 默认 omit 档：剔除 attribution 注入的 UA');

  const body = JSON.parse(seen.init.body);
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.ok(body.instructions, 'codex 后端要求 instructions 非空（无 system 时用中性兜底）');
  assert.ok(Array.isArray(body.input), 'input 必须是 item 数组，不接受字符串简写');
  assert.equal(body.max_output_tokens, undefined, 'codex 后端拒收采样参数，默认剔除');

  assert.deepEqual(
    chunks.map((c) => c.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  );
  assert.deepEqual(chunks[3].block, { type: 'text', text: '你好世界！' });
  // counts 互斥契约：input_tokens 含缓存命中，扣掉单报；reasoning_tokens 是输出子集明细。
  assert.deepEqual(chunks.at(-2).usage, { inputTokens: 8, outputTokens: 7, cacheReadTokens: 3, reasoningTokens: 4 });
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
});

test('openai · 账户模式（Responses）工具调用流：扁平 tools + done 权威参数覆盖', async () => {
  let seen;
  const adapter = new AccountAuthLlmAdapter({
    env: {},
    resolveCredential: async () => ({ mode: 'account', token: 'jwt-token', accountId: 'acct_test', source: 'test' }),
    fetch: async (url, init) => {
      seen = { url, init };
      return sseResponse([
        { event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' } } },
        { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' } },
        { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"b.txt"}' } },
        { event: 'response.output_item.done', data: { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' } } },
        { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 3 } } } },
      ]);
    },
  });

  const chunks = await collect(
    adapter.stream({
      ...BASE,
      system: '你是审核者',
      tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object' } }],
    }),
  );

  const body = JSON.parse(seen.init.body);
  assert.equal(body.instructions, '你是审核者', '有 system 时直接透传为 instructions');
  assert.deepEqual(body.tools, [
    { type: 'function', name: 'read_file', description: '读文件', parameters: { type: 'object' }, strict: false },
  ]);
  assert.equal(body.tool_choice, 'auto');

  assert.deepEqual(
    chunks.map((c) => c.type),
    ['block-start', 'tool-call-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'],
  );
  assert.deepEqual(
    chunks[3].block,
    { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    'done 携带的权威参数覆盖增量累积',
  );
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' });
});

test('账户 id 三级来源与 UA 三档开关（responsesRequest 纯函数矩阵）', () => {
  const jwt = makeJwt({ [JWT_CLAIM]: { chatgpt_account_id: 'acct_jwt' } });
  const profile = PROFILES.openai;
  const options = { model: 'gpt-5.6', messages: BASE.messages };
  const request = (credential, env = {}) => responsesRequest(profile, options, credential, env);

  // ① env 显式覆盖最优先
  assert.equal(
    request({ mode: 'account', token: jwt, accountId: 'acct_cred' }, { DSH_OPENAI_CHATGPT_ACCOUNT_ID: 'acct_env' }).headers['chatgpt-account-id'],
    'acct_env',
  );
  // ② 凭据解析阶段提取的 credential.accountId
  assert.equal(request({ mode: 'account', token: jwt, accountId: 'acct_cred' }).headers['chatgpt-account-id'], 'acct_cred');
  // ③ 兜底：从令牌自身的 JWT 载荷取 claim
  assert.equal(request({ mode: 'account', token: jwt }).headers['chatgpt-account-id'], 'acct_jwt');
  // ④ 都没有：不阻断请求，把可能的 403 暴露出去
  assert.equal(request({ mode: 'account', token: 'opaque-token' }).headers['chatgpt-account-id'], undefined);

  // UA 三档：omit（默认）/ codex / dsh
  const ua = (env) => request({ mode: 'account', token: 'opaque' }, env).headers['user-agent'];
  assert.equal(ua({}), undefined, '默认 omit');
  assert.match(ua({ DSH_OPENAI_ACCOUNT_USER_AGENT: 'codex' }), /^codex_cli_rs\//);
  assert.ok(ua({ DSH_OPENAI_ACCOUNT_USER_AGENT: 'dsh' }), 'dsh 档保留 attribution 注入的 UA');
});

test('凭据解析补全账户 id：env 覆盖 > 文档直存键 > JWT 载荷 claim', async () => {
  const jwt = makeJwt({ [JWT_CLAIM]: { chatgpt_account_id: 'acct_jwt' } });
  const file = join(tmpdir(), 'dsh-llm-account-auth-test-auth.json');
  const profile = {
    ...PROFILES.openai,
    accountOnly: false, // 本测试验证账户 id 提取逻辑，不关心 accountOnly 退化守卫
    accountTokenEnv: ['TEST_ACCOUNT_TOKEN'],
    credentialFiles: [{ path: () => file, keys: ['tokens.access_token'] }],
  };

  // ① accountTokenEnv 令牌 + accountIdEnv 显式覆盖
  const fromEnv = await resolveCredential(profile, { TEST_ACCOUNT_TOKEN: jwt, DSH_OPENAI_CHATGPT_ACCOUNT_ID: 'acct_env' });
  assert.equal(fromEnv.accountId, 'acct_env');

  // ② accountTokenEnv 路径没有凭据文档：从 JWT 载荷提取
  const fromJwt = await resolveCredential(profile, { TEST_ACCOUNT_TOKEN: jwt });
  assert.equal(fromJwt.accountId, 'acct_jwt');

  // ③ CLI 凭据库路径：文档直存键优先于 JWT claim
  await writeFile(file, JSON.stringify({ tokens: { access_token: jwt, account_id: 'acct_doc' } }));
  try {
    const fromDoc = await resolveCredential(profile, {});
    assert.equal(fromDoc.accountId, 'acct_doc');
  } finally {
    await rm(file, { force: true });
  }

  // ④ API Key 模式不做账户 id 提取
  const apiKey = await resolveCredential(profile, { OPENAI_API_KEY: 'sk-xyz' });
  assert.equal(apiKey.mode, 'api-key');
  assert.equal(apiKey.accountId, undefined);
});

test('anthropic · 账户（OAuth）模式走 Bearer + oauth beta 头，工具调用流正确', async () => {
  let seen;
  const adapter = new AccountAuthLlmAdapter({
    resolveCredential: async () => ({ mode: 'account', token: 'oauth-token', source: 'test' }),
    fetch: async (url, init) => {
      seen = { url, init };
      return sseResponse(
        [
          { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 20 } } } },
          {
            event: 'content_block_start',
            data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
          },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ],
        { tail: '' },
      );
    },
  });

  const chunks = await collect(
    adapter.stream({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      system: '你是审核者',
      messages: [{ role: 'user', content: [{ type: 'text', text: '读文件' }] }],
      tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object' } }],
    }),
  );

  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers.authorization, 'Bearer oauth-token');
  assert.equal(seen.init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(seen.init.headers['x-api-key'], undefined, '账户模式不应再发 x-api-key');

  const body = JSON.parse(seen.init.body);
  assert.equal(body.system, '你是审核者');
  assert.equal(body.tools[0].input_schema.type, 'object');
  assert.ok(body.max_tokens, 'Anthropic 的 max_tokens 必填');

  assert.deepEqual(
    chunks.map((c) => c.type),
    ['block-start', 'tool-call-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'],
  );
  assert.deepEqual(chunks[3].block, {
    type: 'tool-call',
    id: 'toolu_1',
    name: 'read_file',
    arguments: '{"path":"a.ts"}',
  });
  assert.deepEqual(chunks.at(-2).usage, { inputTokens: 20, outputTokens: 9 });
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' });
});

test('无凭据时抛 AUTH，并给出可执行指引', async () => {
  const profile = {
    id: 'fake',
    name: 'Fake',
    apiKeyPrefix: 'sk-',
    tokenEnv: ['FAKE_API_KEY'],
    accountTokenEnv: ['FAKE_ACCOUNT_TOKEN'],
    credentialFiles: [{ path: () => '/nonexistent/fake-auth.json', keys: ['token'] }],
  };
  await assert.rejects(() => resolveCredential(profile, {}), (e) => {
    assert.equal(e.code, 'AUTH');
    assert.match(e.message, /FAKE_ACCOUNT_TOKEN/);
    return true;
  });
});

test('401 映射为 AUTH 并保留 status', async () => {
  const adapter = new AccountAuthLlmAdapter({
    resolveCredential: async () => ({ mode: 'api-key', token: 'sk-bad', source: 'test' }),
    fetch: async () => ({
      ok: false,
      status: 401,
      headers: new Headers({ 'x-request-id': 'req_1' }),
      body: null,
      text: async () => 'invalid api key',
    }),
  });

  await assert.rejects(() => collect(adapter.stream({ ...BASE })), (e) => {
    assert.equal(e.code, 'AUTH');
    // LlmError 把可序列化的 provider 事实收在 failure 上（status / requestId / retryAfter）。
    assert.equal(e.failure.status, 401);
    assert.equal(e.failure.requestId, 'req_1');
    return true;
  });
});

test('插件入口：两条路由注册进 llm，并可被 listProviders 发现', () => {
  const registered = [];
  const ctx = {
    llm: {
      registerAdapter(routes, adapter) {
        registered.push({ routes, adapter });
        return () => {};
      },
    },
  };

  apply(ctx);

  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].routes, ['openai', 'anthropic']);

  // 宿主侧 listProviders 的等价物：路由 + providerInfo 就是编辑器下拉的数据源。
  const adapter = registered[0].adapter;
  assert.deepEqual(
    ['openai', 'anthropic'].map((id) => adapter.providerInfo(id)),
    [
      { id: 'openai', name: 'OpenAI' },
      { id: 'anthropic', name: 'Anthropic' },
    ],
  );
});

test('未知路由或重复注册要有明确失败，而不是静默降级', () => {
  const ctx = { llm: { registerAdapter: () => () => {} } };
  assert.throws(() => apply(ctx, { routes: ['gemini'] }), /未知路由/);

  const busy = { llm: { registerAdapter: () => { throw new Error('DUPLICATE_ADAPTER'); } } };
  assert.throws(() => apply(busy), /注册.*失败/);
});

test('令牌分类：前缀命中判为 API Key，其余判为账户令牌', () => {
  assert.equal(classifyToken({ apiKeyPrefix: 'sk-' }, 'sk-abc'), 'api-key');
  assert.equal(classifyToken({ apiKeyPrefix: 'sk-' }, 'eyJhbGciOi'), 'account');
  assert.equal(classifyToken({ apiKeyPrefix: 'sk-ant-' }, 'sk-ant-abc'), 'api-key');
  assert.equal(classifyToken({ apiKeyPrefix: 'sk-ant-' }, 'sk-ory'), 'account');
});

test('账户专用 profile（accountOnly）退出登录时不退化到 API Key，引导重登录', async () => {
  // 复现真实踩坑：codex 退出登录后 ~/.codex/auth.json 整个消失，但 Windows 系统环境变量里
  // 残留一枚无效 OPENAI_API_KEY。OpenAI 账户模式（codex 后端）若退化到它，会误打
  // api.openai.com 的 Chat Completions 并报误导性的「API key is invalid」。
  // accountOnly 必须忽略 API Key 兜底，直接抛 AUTH 引导重登录。
  const profile = {
    id: 'openai',
    name: 'OpenAI',
    requiresAccountId: true,
    accountOnly: true,
    apiKeyPrefix: 'sk-',
    tokenEnv: ['OPENAI_API_KEY'],
    accountTokenEnv: ['DSH_OPENAI_ACCOUNT_TOKEN'],
    credentialFiles: [{ path: () => '/nonexistent/codex-auth.json', keys: ['tokens.access_token'] }],
  };

  await assert.rejects(
    () => resolveCredential(profile, { OPENAI_API_KEY: 'sk-invalid-from-system' }),
    (e) => {
      assert.equal(e.code, 'AUTH');
      assert.match(e.message, /codex login/, '应明确引导重新登录 codex');
      // 文案应澄清「账户专用、不走 API Key」——而不是像通用兜底那样把 OPENAI_API_KEY 列为可设项。
      assert.match(e.message, /不接受 OPENAI_API_KEY/, '应明确声明该模式不接受 OPENAI_API_KEY 退化');
      return true;
    },
  );
});

test('accountOnly · 文件中即使出现 sk- 形令牌也不降级为 API Key（强制账户模式）', async () => {
  // 复现潜在误判：若 codex auth.json 里混有一枚 sk- 开头的令牌（无论来源），classifyToken
  // 默认会判成 API Key。但 accountOnly 模式（codex 后端）绝不该把它当 OPENAI_API_KEY 去打
  // 官方 API——必须强制 account，走 codex 后端拿到真实的鉴权错误，而非误导性的「API key is invalid」。
  const file = join(tmpdir(), `dsh-acct-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify({ tokens: { access_token: 'sk-spurious-from-file' } }), 'utf8');
  try {
    const profile = {
      id: 'openai',
      name: 'OpenAI',
      requiresAccountId: true,
      accountOnly: true,
      apiKeyPrefix: 'sk-',
      credentialFiles: [{ path: () => file, keys: ['tokens.access_token'] }],
    };
    const cred = await resolveCredential(profile, {});
    assert.equal(cred.mode, 'account', 'accountOnly 下文件来源必须是账户模式');
    assert.equal(cred.token, 'sk-spurious-from-file');
  } finally {
    await rm(file, { force: true });
  }
});

test('凭据库条目声明 forceMode 时不走前缀启发式（Claude OAuth 令牌误判回归）', async () => {
  // Claude 的 OAuth 令牌（sk-ant-oat01-…）以 sk-ant- 开头，前缀启发式会误判为 API Key；
  // claudeAiOauth.* 键名结构已明确是账户登录态，条目级 forceMode 优先。
  const file = join(tmpdir(), 'dsh-llm-account-auth-test-force-mode.json');
  const profile = {
    id: 'anthropic-like',
    name: 'AnthropicLike',
    apiKeyPrefix: 'sk-ant-',
    credentialFiles: [{ path: () => file, keys: ['claudeAiOauth.accessToken'], forceMode: 'account' }],
  };
  await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } }));
  try {
    const credential = await resolveCredential(profile, {});
    assert.equal(credential.mode, 'account', 'forceMode 优先于 apiKeyPrefix 启发式');
  } finally {
    await rm(file, { force: true });
  }
});
