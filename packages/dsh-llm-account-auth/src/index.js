// DSH 插件入口：把 openai / anthropic 两条账户鉴权路由注册进 ctx.llm。
//
// 注册后：
//   · llm.listProviders() 会列出这两条路由 → vwf 编辑器节点模型下拉即可选中
//     （client.js 的下拉项来自 listProviders，不是硬编码）；
//   · 蓝图 bindings.models 里写 {"provider":"anthropic","model":"claude-sonnet-5"} 即可路由过来。
//
// 注册随调用 fiber 释放，无需手动 dispose。

import { AccountAuthLlmAdapter } from './adapter.js';
import { PROFILES, ROUTE_IDS } from './profiles.js';

export const name = 'llm-account-auth';

export { AccountAuthLlmAdapter, PROFILES, ROUTE_IDS };

/**
 * @param {object} ctx Cordis 上下文（DSH 宿主）。
 * @param {{routes?: string[], fetch?: typeof globalThis.fetch, env?: NodeJS.ProcessEnv}} [config]
 */
export function apply(ctx, config = {}) {
  // 与本仓库 vwf 插件一致的取服务方式（动态插件用 ctx.get，Cordis 风格也可直接 ctx.llm）。
  const llm = ctx.get ? ctx.get('llm') : ctx.llm;
  if (!llm) {
    throw new Error('[llm-account-auth] 未取到 llm 服务：请在 dsh 插件环境中挂载');
  }

  const routes = config.routes ?? ROUTE_IDS;
  const unknown = routes.filter((id) => !PROFILES[id]);
  if (unknown.length) {
    throw new Error(`[llm-account-auth] 未知路由：${unknown.join('、')}（可用：${ROUTE_IDS.join('、')}）`);
  }

  const adapter = new AccountAuthLlmAdapter(config);

  try {
    // all-or-nothing：任一条路由已被别的适配器占用则整批失败（DUPLICATE_ADAPTER）。
    llm.registerAdapter(routes, adapter);
  } catch (error) {
    throw new Error(
      `[llm-account-auth] 注册 ${routes.join('、')} 失败（可能已被其他适配器占用）：${error?.message ?? error}`,
      { cause: error },
    );
  }
}

export default { name, apply };
