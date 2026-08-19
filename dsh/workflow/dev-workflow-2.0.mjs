// ============================================================================
// 开发工作流 2.0 — DSH 编排脚本
//
// 本文件是 workflow 工具 script 参数的版本控制源：运行时把本文件全文作为
// script 传入，args 按 dsh/README.md 的契约装配（角色提示词从 dsh/roles/*.md 读入）。
//
// 迁移自 gold-band DSL 模板（已归档 .scratch/retired-goldband/workflows/dev-workflow-2.0.json）；
//   7 节点（调度/开发/分流/测试/审核/人工验收/收口），打回上限 9 轮。
// DSH 侧差异：
//   - 「分流」不再是 LLM 节点，是脚本内 if（严格满足"只转发不重新分析"）；
//   - 结构化闸门由 agent() 的 schema 校验完成，与引擎流式协议无关；
//   - 9 轮超限后自动回调度做失败归因与拆分建议（gold-band 需人工重新调度）；
//   - 人工验收门禁在脚本外：本脚本跑到 AWAITING_HUMAN_ACCEPTANCE 即返回，
//     由主会话呈报告、等人工裁决，再以 entry=closeout / entry=dev 续跑；
//   - 多任务隔离用 git worktree 物理隔离：dev/test/review 在独立 worktree
//     （<runDir>/worktree，分支 dev2/<taskId>）中作业，主工作区只承担 push/pr/merge/close，
//     消除「main 被占用」与「共享工作区未提交改动被覆盖」两类互踩阻塞。
// ============================================================================

const A = args || {};

// ---------- 0. 参数校验 ----------
if (!A.taskId) throw new Error('缺少 args.taskId（任务标识，如 issue-123）');
if (!A.runDir) throw new Error('缺少 args.runDir（run 产物目录，如 .agent-runs/issue-123）');
const ENTRY = A.entry || 'dispatch';
if (['dispatch', 'dev', 'accept', 'closeout'].indexOf(ENTRY) < 0) {
  throw new Error('args.entry 必须是 dispatch / dev / accept / closeout 之一，当前：' + ENTRY);
}
if ((ENTRY === 'dev' || ENTRY === 'accept') && !A.dispatch) {
  throw new Error('entry=' + ENTRY + ' 需要 args.dispatch（前次调度结论 JSON）');
}
if (ENTRY === 'dispatch' && !A.issueBody && !A.requirement) {
  throw new Error('entry=dispatch 需要 args.issueBody（GitHub issue 正文）或 args.requirement（需求文本）');
}

const MAX_ROUNDS = 9;
const taskId = A.taskId;
const runDir = A.runDir;
const repoPath = A.repoPath || '当前会话工作区根目录';
const baseBranch = A.baseBranch || 'main';
const workBranch = 'dev2/' + taskId;
const worktreePath = runDir + '/worktree';
const models = A.models || {};
const history = A.history || [];

// ---------- 异源检查（开发/审核必须异源）----------
function modelTag(role) {
  const m = models[role];
  return m ? (m.provider || 'default') + '/' + (m.model || 'default') : 'default';
}
const heterogeneous = modelTag('dev') !== modelTag('review');
if (!heterogeneous) {
  log('⚠️ 开发与审核使用同一模型（' + modelTag('dev') + '）：当前为弱异源（不同角色、不同会话）。要满足「异源异模型」硬规则，请在 args.models.review 指定不同 provider 或 model。');
}

function mo(role) {
  const m = models[role];
  if (!m) return {};
  const o = {};
  if (m.provider) o.provider = m.provider;
  if (m.model) o.model = m.model;
  return o;
}

// ---------- 结构化产出 schema（仅用受支持关键字：type/properties/required/additionalProperties/items/enum/const/oneOf）----------
const dispatchSchema = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    missing: { type: 'array', items: { type: 'string' } },
    objective: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    scope: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    acceptance: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    need_integration_test: { type: 'boolean' },
    reason: { type: 'string' },
    reschedule: {
      oneOf: [{
        type: 'object',
        properties: {
          attribution: { type: 'string' },
          split: { type: 'array', items: { type: 'string' } },
          human_action: { type: 'string' },
        },
        required: ['attribution', 'split', 'human_action'],
        additionalProperties: false,
      }, { type: 'null' }],
    },
  },
  required: ['complete', 'missing', 'objective', 'scope', 'acceptance', 'need_integration_test', 'reason'],
  additionalProperties: false,
};

const devSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked'] },
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    self_verify: { type: 'string' },
    risks: { type: 'string' },
  },
  required: ['status', 'summary', 'self_verify'],
  additionalProperties: false,
};

const testSchema = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['PASSED', 'FAILED', 'BLOCKED'] },
    reason: { type: 'string' },
    evidence: { type: 'string' },
    failed_cases: { type: 'string' },
    verified_branch: { type: 'string' },
    verified_head: { type: 'string' },
  },
  required: ['result', 'reason', 'evidence', 'verified_branch', 'verified_head'],
  additionalProperties: false,
};

const reviewSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT_ONLY'] },
    blockers: { type: 'string' },
    compliance: { type: 'string' },
    summary: { type: 'string' },
    verified_branch: { type: 'string' },
    verified_head: { type: 'string' },
  },
  required: ['verdict', 'summary', 'verified_branch', 'verified_head'],
  additionalProperties: false,
};

const acceptSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'INCOMPLETE'] },
    summary_for_human: { type: 'string' },
    details: { type: 'string' },
    verified_branch: { type: 'string' },
    verified_head: { type: 'string' },
  },
  required: ['verdict', 'summary_for_human', 'verified_branch', 'verified_head'],
  additionalProperties: false,
};

const closeoutSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done'] },
    summary: { type: 'string' },
    followups: { type: 'string' },
  },
  required: ['status', 'summary'],
  additionalProperties: false,
};

// ---------- 运行上下文块 ----------
const roleDir = A.roleDir || 'dsh/roles';

// 角色提示词不进 args：agent 开工时自行读文件（单一事实源 = dsh/roles/*.md）
function roleRef(name) {
  return '【角色定义】开工前先用读文件工具读取 ' + roleDir + '/' + name + '.md（相对当前工作区根目录），'
    + '严格遵循其中的定位、工作流程、产出模板、判定标准与硬规则——该文件是你在本节点的唯一角色依据。\n';
}

const issueBlock = A.issueBody
  ? 'GitHub issue ' + (A.issueRef || '') + '\n标题：' + (A.issueTitle || '（未提供）') + '\n正文：\n' + A.issueBody + (A.issueComments ? '\n\n需求确认相关评论：\n' + A.issueComments : '')
  : '原始需求文本（运行时直接给出，以此为准）：\n' + A.requirement;

function ctx(nodeName, extra) {
  return '\n\n---\n\n## 运行上下文（编排脚本注入，以此为准）\n\n'
    + '- 任务标识：' + taskId + '\n'
    + '- 目标仓库：' + repoPath + '\n'
    + '- run 产物目录：' + runDir + '/（不存在则创建；本节点只允许在该目录内写文件）\n'
    + '- base 分支：' + baseBranch + '；工作分支：' + workBranch + '\n'
    + '- 工作区隔离（worktree）：作业在独立 worktree `' + worktreePath + '`（分支 `' + workBranch + '`）中进行；主工作区（' + repoPath + '）停在 ' + baseBranch + '，只承担 push/pr/merge/close。\n'
    + '- 当前节点：' + nodeName + '\n'
    + '- STATE.md：完成本节点后更新 ' + runDir + '/STATE.md（stage / round / status / updated 四行，时间用 `date -u +%FT%TZ` 获取）\n'
    + (extra ? '\n' + extra + '\n' : '')
    + '\n## 最终回复要求\n\n'
    + '完成上述全部工作（含写报告文件、更新 STATE.md）后，最终回复只给出结构化结果本身，'
    + '不要复述报告全文，不要添加 schema 之外的字段。\n';
}

// ---------- 验证节点开工前置（分支自检） ----------
// test/review/accept 的验证结论必须可信：开工先确认 worktree 分支 = 工作分支且 HEAD 一致，
// 否则会复现「验证跑在错误分支 → 结论与证据不可信、验收指引复现相反结果」的事故。
function verifyBranchStep() {
  return '开工前置（强制，先于任何验证命令）：开工先确认 worktree 分支 = ' + workBranch + '，不在则先恢复——\n'
    + '   - `git -C ' + worktreePath + ' rev-parse --abbrev-ref HEAD` 必须等于 ' + workBranch + '；\n'
    + '   - `git -C ' + worktreePath + ' rev-parse HEAD` 的 HEAD 必须与 worktree 实际提交一致；\n'
    + '   - 分支不在 ' + workBranch + '（或 worktree 缺失/脏）时先恢复：worktree 缺失用 `git worktree add '
    + worktreePath + ' ' + workBranch + '`，分支错位用 `git -C ' + worktreePath + ' checkout ' + workBranch
    + '`，恢复后再开工。\n'
    + '   所有验证命令一律 `git -C ' + worktreePath + ' ...` 方式在该 worktree 内执行；'
    + '验证结论必须记录 verified_branch（实际验证分支）与 verified_head（实际 HEAD commit）。';
}

// ---------- 验证结论硬校验（编排层，不依赖节点自觉） ----------
// test/review/accept 的结论必须声称验证运行于真实工作分支：verified_branch 必须与工作分支
// 纯字符串相等、verified_head 必须非空（否则结论不可信，会复现「验证跑在错误分支 → 结论与
// 证据不可信」的事故）。此处只做纯字符串校验，不引入脚本层 git 执行。返回 null 表示通过，
// 否则返回含实际值的失败原因字符串（由调用点组装为 TECHNICAL_FAILURE 打回）。
function claimError(res, stage) {
  const head = res && res.verified_head;
  const headOk = typeof head === 'string' && head.trim().length > 0;
  if (res && res.verified_branch === workBranch && headOk) return null;
  return stage + ' 结论校验失败：verified_branch=' + JSON.stringify(res && res.verified_branch)
    + '（应为 ' + workBranch + '），verified_head=' + JSON.stringify(head)
    + '（应为非空 HEAD commit）';
}

// ---------- 各节点提示词 ----------
function dispatcherPrompt(rescheduleRound) {
  const extra =
    '【输入】\n' + issueBlock + '\n\n'
    + (A.priorFailure ? '【历史失败记录（超限重调度场景）】\n' + A.priorFailure + '\n\n' : '')
    + (rescheduleRound ? '【本次为超限重调度分析】该任务已在开发循环中打回超过 ' + MAX_ROUNDS + ' 轮。历史记录：\n' + rescheduleRound + '\n必须在 reschedule 字段给出：失败归因（卡在哪个环节）、拆分建议（可独立验收的子任务列表）、人工介入建议。\n\n' : '')
    + '【产物】把调度结论 JSON 写入 ' + runDir + '/dispatch-result.json（允许写此文件）；'
    + (A.priorFailure || rescheduleRound ? '超限重调度场景必须填写 reschedule 字段。' : '非超限场景 reschedule 填 null。');
  return roleRef('dispatcher') + ctx('调度', extra);
}

function devPrompt(round, dispatch, feedback) {
  const extra =
    '【调度结论 dispatch-result】\n```json\n' + JSON.stringify(dispatch, null, 2) + '\n```\n\n'
    + '【当前轮次】第 ' + round + ' / ' + MAX_ROUNDS + ' 轮\n\n'
    + (feedback ? '【上轮打回反馈——必须逐条修复】\n' + feedback + '\n\n' : '')
    + '【本节点任务】\n'
    + '1. 建立/复用独立 worktree（作业区 = ' + worktreePath + '，分支 ' + workBranch + '）：\n'
    + '   - 首次：git worktree add ' + worktreePath + ' -b ' + workBranch + ' ' + baseBranch + '（若分支已存在但 worktree 不在，则 git worktree add ' + worktreePath + ' ' + workBranch + '）。\n'
    + '   - 续跑（' + worktreePath + ' 已存在）：直接复用，git -C ' + worktreePath + ' status 确认后继续。\n'
    + '   全程只在 worktree 内读写与提交；不切换主工作区（' + repoPath + '）的分支、不触碰其它任务文件。\n'
    + '2. 读取 ' + runDir + '/dispatch-result.json 与 STATE.md（如有），按调度结论施工（tdd：先写会失败的本地校验脚本再写实现）。\n'
    + '3. 在 worktree 内本地验证全绿后提交（git -C ' + worktreePath + ' add . && git -C ' + worktreePath + ' commit；不推送、不建 PR——推送与 Draft PR 由收口节点统一完成）。\n'
    + '4. 写 ' + runDir + '/dev-report.md（按角色规定的模板），更新 STATE.md。\n'
    + '环境受阻（依赖缺失、命令不可用等）无法完成时，status 报 blocked 并在 summary 说明具体阻塞，不要硬撑。';
  return roleRef('dev') + ctx('开发', extra);
}

function testPrompt(round, dispatch) {
  const extra =
    '【验收标准（调度结论）】\n' + (dispatch.acceptance || '见 ' + runDir + '/dispatch-result.json') + '\n\n'
    + '【当前轮次】第 ' + round + ' / ' + MAX_ROUNDS + ' 轮\n\n'
    + '【本节点任务】\n'
    + verifyBranchStep() + '\n'
    + '1. 读取 ' + runDir + '/dev-report.md、' + runDir + '/review-report.md（如有）与 dispatch-result.json。\n'
    + '2. 在 worktree（' + worktreePath + '，分支 ' + workBranch + '）内执行运行态验证（单测/集测/类型检查/构建，按改动性质选择），逐项对照验收标准。\n'
    + '3. 收集命令输出作为证据；环境无法验证时 result=BLOCKED 并写明阻塞原因。\n'
    + '4. 写 ' + runDir + '/test-report.md（按角色规定的模板），更新 STATE.md。';
  return roleRef('test') + ctx('测试', extra);
}

function reviewPrompt(round, dispatch, testRes) {
  const extra =
    '【调度结论】目标：' + (dispatch.objective || '') + '\n范围：' + (dispatch.scope || '') + '\n验收标准：' + (dispatch.acceptance || '') + '\n\n'
    + '【当前轮次】第 ' + round + ' / ' + MAX_ROUNDS + ' 轮\n'
    + (testRes ? '【测试结论】' + testRes.result + '：' + testRes.reason + '\n' : '【测试环节】本轮无需集成测试（调度判定），无 test-report。\n')
    + '\n【本节点任务】\n'
    + verifyBranchStep() + '\n'
    + '1. 读取 ' + runDir + '/dev-report.md、test-report.md（如有）、dispatch-result.json。\n'
    + '2. 以 dev-report 列出的文件与行为审查范围（无则以 ' + workBranch + ' 相对 ' + baseBranch + ' 的 diff 为范围：git diff ' + baseBranch + '...' + workBranch + '，或直接读 worktree ' + worktreePath + '），双轴审查：需求符合性优先，代码质量其次。\n'
    + '3. 对修改过的文件做类型诊断（如项目有类型系统）。\n'
    + '4. 写 ' + runDir + '/review-report.md（按角色规定的模板），更新 STATE.md。';
  return roleRef('review') + ctx('审核', extra);
}

function acceptPrompt(dispatch) {
  const extra =
    '【调度结论】目标：' + (dispatch.objective || '') + '\n验收标准：' + (dispatch.acceptance || '') + '\n\n'
    + '【本节点任务】\n'
    + verifyBranchStep() + '\n'
    + '1. 读取 ' + runDir + '/ 下全部报告（dev-report / test-report / review-report）与 dispatch-result.json。\n'
    + '2. 逐条核对验收标准达成情况；证据缺失/过期/矛盾时做针对性只读验证（只读，不改任何文件）。\n'
    + '3. 写 ' + runDir + '/acceptance-summary.md（通俗版）与 ' + runDir + '/accept-report.md（严格版），更新 STATE.md。\n'
    + '4. summary_for_human 用非技术语言概括：任务目标一句话、逐条达成情况 ✅/⚠️/❌、人工可以这样确认（打开看/动手试/跑一下/看证据）。\n'
    + '注意：你只产出核验结论与报告，人工确认由编排层在脚本外完成，不得代签。';
  return roleRef('accept') + ctx('人工验收（AI 核验与报告）', extra);
}

function closeoutPrompt() {
  const extra =
    '【本节点任务】\n'
    + '1. 读取 ' + runDir + '/ 下全部报告终态（dev / test / review / accept / acceptance-summary）。\n'
    + '2. 一致性收口：代码/文档/规则对齐，确认无遗留死代码与格式漂移。\n'
    + '3. 写 ' + runDir + '/cleanup-report.md（按角色规定的模板），更新 STATE.md 为 done。\n'
    + '4. 推送、合并与关闭：git push -u origin ' + workBranch + '；gh pr create --draft --base ' + baseBranch + ' --head ' + workBranch + '（已存在则复用；标题概括需求，正文汇总目标/验收结论/报告清单）；然后 gh pr ready + gh pr merge --squash --delete-branch；合并依据是「人工验收已通过」的前置决策，你只执行、不重新判定。禁止绕过 PR 直接推送 ' + baseBranch + '；无远端时记录本地 commit 清单。\n'
    + (A.issueRef ? '5. gh issue close ' + A.issueRef.replace('#', '') + ' --comment：验收通过结论 + 合并 commit + run 产物位置。\n' : '')
    + '6. 工作区收束：只处理本任务（' + workBranch + '）相关变更，不触碰无关文件与已有未提交改动；合并后原子清理 worktree：git worktree remove ' + worktreePath + '（worktree 内有本任务遗留未提交/未跟踪文件时先确认归属再 git worktree remove --force ' + worktreePath + '），残留本地分支用 git branch -D ' + workBranch + '；主工作区（' + repoPath + '）停在 ' + baseBranch + '，如需同步 git pull；输出提交状态或待提交清单。';
  return roleRef('closeout') + ctx('收口', extra);
}

// ---------- 主流程 ----------
let dispatch = A.dispatch || null;
let reviewRes = null;
let testRes = null;
let passedReview = false;
let round = A.startRound || 1;
let feedback = A.feedback || '';

// 阶段一：调度
if (ENTRY === 'dispatch') {
  phase('调度');
  dispatch = await agent(dispatcherPrompt(null), { label: '调度', schema: dispatchSchema, ...mo('dispatcher') });
  if (!dispatch) {
    return { status: 'TECHNICAL_FAILURE', stage: 'dispatch', taskId, runDir, detail: '调度 agent 未返回有效结果' };
  }
  if (!dispatch.complete) {
    log('三要素缺失：' + ((dispatch.missing || []).join('、') || '见 reason'));
    return { status: 'REJECTED_INCOMPLETE', stage: 'dispatch', taskId, runDir, dispatch };
  }
  log('三要素齐全；需要集成测试：' + dispatch.need_integration_test);
}

// 阶段二：开发循环（开发 → [测试] → 审核，打回最多 9 轮）
if (ENTRY === 'dispatch' || ENTRY === 'dev') {
  phase('开发循环');
  for (; round <= MAX_ROUNDS; round++) {
    log('—— 第 ' + round + ' / ' + MAX_ROUNDS + ' 轮 ——');

    const devRes = await agent(devPrompt(round, dispatch, feedback), { label: '开发 R' + round, schema: devSchema, ...mo('dev') });
    if (!devRes) return { status: 'TECHNICAL_FAILURE', stage: 'dev', round, taskId, runDir, dispatch, history, detail: '开发 agent 未返回有效结果' };
    if (devRes.status === 'blocked') return { status: 'BLOCKED', stage: 'dev', round, taskId, runDir, dispatch, history, detail: devRes };
    log('开发完成：' + devRes.summary);

    // 分流：脚本内分支，严格转发调度结论，不再调用 LLM
    if (dispatch.need_integration_test) {
      testRes = await agent(testPrompt(round, dispatch), { label: '测试 R' + round, schema: testSchema, ...mo('test') });
      if (!testRes) return { status: 'TECHNICAL_FAILURE', stage: 'test', round, taskId, runDir, dispatch, history, detail: '测试 agent 未返回有效结果' };
      const testClaimErr = claimError(testRes, 'test');
      if (testClaimErr) return { status: 'TECHNICAL_FAILURE', stage: 'test', round, taskId, runDir, dispatch, history, detail: testClaimErr };
      if (testRes.result === 'BLOCKED') return { status: 'BLOCKED', stage: 'test', round, taskId, runDir, dispatch, history, detail: testRes };
      if (testRes.result === 'FAILED') {
        feedback = '【测试不通过 · 第 ' + round + ' 轮】' + testRes.reason + '\n失败用例：' + (testRes.failed_cases || '见 test-report.md') + '\n证据：' + testRes.evidence;
        history.push({ round, stage: 'test', verdict: 'FAILED', reason: testRes.reason });
        log('测试 FAILED，打回开发：' + testRes.reason);
        continue;
      }
      log('测试 PASSED');
    } else {
      testRes = null;
      log('调度判定无需集成测试，直送审核');
    }

    reviewRes = await agent(reviewPrompt(round, dispatch, testRes), { label: '审核 R' + round, schema: reviewSchema, ...mo('review') });
    if (!reviewRes) return { status: 'TECHNICAL_FAILURE', stage: 'review', round, taskId, runDir, dispatch, history, detail: '审核 agent 未返回有效结果' };
    const reviewClaimErr = claimError(reviewRes, 'review');
    if (reviewClaimErr) return { status: 'TECHNICAL_FAILURE', stage: 'review', round, taskId, runDir, dispatch, history, detail: reviewClaimErr };
    if (reviewRes.verdict === 'REQUEST_CHANGES') {
      feedback = '【审核打回 · 第 ' + round + ' 轮】阻塞问题：' + (reviewRes.blockers || '见 review-report.md') + '\n' + reviewRes.summary;
      history.push({ round, stage: 'review', verdict: 'REQUEST_CHANGES', reason: reviewRes.summary });
      log('审核 REQUEST_CHANGES，打回开发');
      continue;
    }
    log('审核 ' + reviewRes.verdict + '，进入人工验收');
    passedReview = true;
    break;
  }

  if (!passedReview) {
    // 9 轮超限：自动回调度做失败归因与拆分建议（gold-band 需人工重新调度，此处流程内完成）
    phase('超限重调度');
    const historyText = history.map(function (h) { return '第 ' + h.round + ' 轮 [' + h.stage + '] ' + h.verdict + '：' + h.reason; }).join('\n');
    const re = await agent(dispatcherPrompt(historyText), { label: '超限归因', schema: dispatchSchema, ...mo('dispatcher') });
    return {
      status: 'FAILED_MAX_ROUNDS', taskId, runDir, rounds: MAX_ROUNDS, history, dispatch,
      reschedule: re && re.reschedule ? re.reschedule : null,
      reschedule_reason: re ? re.reason : '超限归因 agent 未返回有效结果',
    };
  }
}

// 阶段三：人工验收（AI 核验与双报告；人工确认在脚本外由主会话完成）
if (passedReview || ENTRY === 'accept') {
  phase('人工验收');
  const acceptRes = await agent(acceptPrompt(dispatch), { label: '验收核验', schema: acceptSchema, ...mo('accept') });
  if (!acceptRes) return { status: 'TECHNICAL_FAILURE', stage: 'accept', taskId, runDir, dispatch, history, detail: '验收 agent 未返回有效结果' };
  const acceptClaimErr = claimError(acceptRes, 'accept');
  if (acceptClaimErr) return { status: 'TECHNICAL_FAILURE', stage: 'accept', taskId, runDir, dispatch, history, detail: acceptClaimErr };
  return {
    status: 'AWAITING_HUMAN_ACCEPTANCE', taskId, runDir, round, dispatch, history,
    review: reviewRes, accept: acceptRes,
    heterogeneity: { dev: modelTag('dev'), review: modelTag('review'), enforced: heterogeneous },
    next: '人工确认通过 → 以 entry=closeout 续跑；不通过 → 以 entry=dev + feedback=人工意见 + startRound=' + (round + 1) + ' 续跑（总数不超过 ' + MAX_ROUNDS + ' 轮）',
  };
}

// 阶段四：收口（仅人工验收通过后进入；不打回）
if (ENTRY === 'closeout') {
  phase('收口');
  const closeRes = await agent(closeoutPrompt(), { label: '收口', schema: closeoutSchema, ...mo('closeout') });
  if (!closeRes) return { status: 'TECHNICAL_FAILURE', stage: 'closeout', taskId, runDir, detail: '收口 agent 未返回有效结果' };
  return { status: 'DONE', taskId, runDir, closeout: closeRes };
}

throw new Error('编排状态异常：entry=' + ENTRY + ' 未匹配任何阶段');
