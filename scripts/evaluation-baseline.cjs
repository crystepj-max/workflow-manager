// LOC-027 评价基线冻结契约——纯计算内核（候选：records-host 同域拆分，宿主载荷瘦身）。
// 消费方：宿主（packages/dsh-visual-workflow/src/host.js）经 dist 以 loadDist 加载（vm 沙箱
// 只做纯计算）；测试直接 import（真实 fs/crypto 语义经 snippetSource() 在真实子进程验证）。
// 职责：[eb-freeze] 冻结请求行解析、冻结/核验子进程脚本文本、冻结载荷与已核验基线引用
// （evaluation_baseline_ref = { run_id, version, artifact_path, algorithm, digest, supersedes? }）
// 构造、闸门阻断判定与恢复参数装配。进程边界（runNode）与引擎编排（abort/resume/入档）留在宿主。
'use strict'

// 冻结/核验子进程脚本（node -e）：字节级 SHA-256 + 版本隔离不可变副本 + 原路径事后核验。
// freeze：读原始字节 → sha256 → 与模型声称值比对（只比对不纠正）→ 副本已存在且内容不同
// 则 IMMUTABLE_CONFLICT（禁止覆写）→ baseline.json 清单（幂等：已存在不重写）。
// verify：清单/副本/原路径逐字节比对；原路径改写或缺失 = 基线冲突；证据缺失 fail closed。
function snippetSource() {
  return [
    "const fs=require('fs'),crypto=require('crypto');",
    'const p=JSON.parse(process.argv[1]||"{}");',
    'const out=(o)=>process.stdout.write(JSON.stringify(o));',
    '(function main(){try{',
    'if(p.mode==="freeze"){',
    'let buf;try{buf=fs.readFileSync(p.source)}catch(e){out({ok:false,code:(e&&e.code)==="ENOENT"?"FILE_MISSING":"NOT_READABLE",error:String((e&&e.message)||e)});return}',
    'const digest=crypto.createHash("sha256").update(buf).digest("hex");',
    'const claimed=p.claimed_digest?String(p.claimed_digest).trim().toLowerCase():null;',
    'const match=claimed===null?null:(claimed===digest);',
    'fs.mkdirSync(p.copy_dir,{recursive:true});',
    'const copy_path=p.copy_dir+"/"+p.filename;',
    'if(fs.existsSync(copy_path)){let same=false;try{same=Buffer.compare(buf,fs.readFileSync(copy_path))===0}catch(e){}',
    'if(!same){out({ok:false,code:"IMMUTABLE_CONFLICT",digest:digest,copy_path:copy_path,error:"冻结副本已存在且内容不同（不可变副本禁止覆写）"});return}}',
    'else{fs.writeFileSync(copy_path,buf)}',
    'const manifest_path=p.copy_dir+"/baseline.json";',
    'if(!fs.existsSync(manifest_path)){fs.writeFileSync(manifest_path,JSON.stringify({run_id:p.run_id,version:p.version,algorithm:"sha256",digest:digest,artifact_path:copy_path,source_path:p.source,claimed_digest:p.claimed_digest||null,match:match,supersedes:p.supersedes||null,frozen_at:new Date().toISOString()},null,2)+"\\n")}',
    'out({ok:true,code:"FROZEN",digest:digest,copy_path:copy_path,size:buf.length,match:match,version:p.version});return}',
    'if(p.mode==="verify"){',
    'let manifest=null;try{manifest=JSON.parse(fs.readFileSync(p.copy_dir+"/baseline.json","utf8"))}catch(e){out({ok:false,code:"MANIFEST_MISSING",error:"基线清单缺失（无法核验）"});return}',
    'let copy=null;try{copy=fs.readFileSync(manifest.artifact_path)}catch(e){out({ok:false,code:"COPY_MISSING",error:"冻结副本缺失（无法核验）"});return}',
    'const copy_digest=crypto.createHash("sha256").update(copy).digest("hex");',
    'if(copy_digest!==manifest.digest){out({ok:true,conflict:true,code:"COPY_CONFLICT",expected:manifest.digest,observed:copy_digest});return}',
    'let src=null;try{src=fs.readFileSync(p.source)}catch(e){out({ok:true,conflict:true,code:"SOURCE_MISSING",expected:manifest.digest,observed:null});return}',
    'const src_digest=crypto.createHash("sha256").update(src).digest("hex");',
    'if(src_digest!==manifest.digest){out({ok:true,conflict:true,code:"SOURCE_REWRITTEN",expected:manifest.digest,observed:src_digest});return}',
    'out({ok:true,conflict:false,code:"VERIFIED",digest:manifest.digest,version:manifest.version});return}',
    'out({ok:false,code:"UNKNOWN_MODE",error:"未知模式"});',
    '}catch(e){out({ok:false,code:"FREEZE_FAILED",error:String((e&&e.message)||e)})}})()',
  ].join('\n')
}

// 解析编译脚本输出的 [eb-freeze] 冻结请求行（损坏行返回 null，不作为冻结依据）
function parseFreezeRequest(message) {
  const raw = String(message || '')
  const idx = raw.indexOf('[eb-freeze]')
  if (idx < 0) return null
  let req = null
  try { req = JSON.parse(raw.slice(idx + '[eb-freeze]'.length)) } catch (e) { return null }
  if (!req || typeof req !== 'object' || !Number.isFinite(Number(req.version))) return null
  return {
    version: Math.trunc(Number(req.version)),
    claimed_digest: req.claimed_digest === undefined || req.claimed_digest === null ? null : String(req.claimed_digest),
    supersedes: req.supersedes && typeof req.supersedes === 'object' ? { version: Math.trunc(Number(req.supersedes.version) || 0), digest: String(req.supersedes.digest || '') } : null,
  }
}

// 冻结载荷（runDir 相对路径与编译脚本 RUNDIR 口径一致：<runDir||.agent-runs/<taskId>>/…）
function freezePayload(opts) {
  const runDirRel = opts.runDir || ('.agent-runs/' + opts.taskId)
  const base = opts.cwd ? (opts.cwd + '/' + runDirRel) : runDirRel
  return {
    mode: 'freeze',
    source: base + '/' + opts.artifact,
    copy_dir: base + '/evaluation-baselines/v' + opts.req.version,
    filename: opts.artifact,
    run_id: opts.taskId,
    version: opts.req.version,
    claimed_digest: opts.req.claimed_digest,
    supersedes: opts.req.supersedes,
  }
}

// runNode 结果 → 解析后的子进程 JSON（传输失败统一为 FREEZE_FAILED，不留裸异常）
function parseSubprocessJson(r) {
  if (!r || r.ok !== true) return { ok: false, code: 'FREEZE_FAILED', error: String((r && r.detail) || '子进程调用失败') }
  try {
    const parsed = JSON.parse(r.stdout)
    return parsed && typeof parsed === 'object' ? parsed : { ok: false, code: 'FREEZE_FAILED', error: '子进程输出不可解析' }
  } catch (e) { return { ok: false, code: 'FREEZE_FAILED', error: '子进程输出不可解析：' + String((e && e.message) || e) } }
}

// 冻结结果 → 阻断判定（缺失/不可读/不可变冲突/摘要与模型声称值不符 → BLOCKED，不进入执行）
function gateBlockOf(frozen, req, producerNode) {
  const entry = 'wf_run entry=' + producerNode
  if (!frozen || frozen.ok !== true) {
    return {
      code: 'EVALUATION_BASELINE_' + String((frozen && frozen.code) || 'FREEZE_FAILED'),
      event: 'evaluation_baseline_freeze_failed',
      message: '评价基线冻结失败（v' + req.version + '）：' + String((frozen && frozen.error) || '未知') + '。原评价文件缺失/不可读或冻结宿主不可用时不得进入执行。',
      recovery_hint: '恢复 ' + req.source + ' 后重新确认评价基线（' + entry + '）',
      version: req.version,
    }
  }
  if (frozen.match === false) {
    return {
      code: 'EVALUATION_BASELINE_DIGEST_MISMATCH',
      event: 'evaluation_baseline_digest_mismatch',
      message: '评价基线摘要与模型声称值不一致（v' + req.version + '）：声称 ' + String(req.claimed_digest) + '，真实 ' + String(frozen.digest) + '。模型摘要不作为权威值，不自动纠正其专业结果。',
      recovery_hint: '从确认节点重新确认并如实上报摘要（' + entry + '）',
      version: req.version,
    }
  }
  return null
}

// 冻结成功 → 已核验基线引用（算法固定 sha256，副本路径为权威 artifact_path）
function baselineRefOf(frozen, req, taskId) {
  if (!frozen || frozen.ok !== true) return null
  const ref = {
    run_id: taskId,
    version: req.version,
    artifact_path: String(frozen.copy_path),
    source_path: String(req.source),
    algorithm: 'sha256',
    digest: String(frozen.digest),
    status: 'verified',
  }
  if (req.supersedes) ref.supersedes = req.supersedes
  return ref
}

// 恢复段参数装配：检查点现场 + 已核验基线引用（剥掉人工决策字段，杜绝绕过）
function resumeArgsOf(scriptArgs, ck, ref) {
  const src = require('./state-recovery-core.cjs')
  const args = Object.assign({}, scriptArgs, src.checkpointToResumeFields(ck), {
    evaluation_baseline: ref,
    evaluation_baseline_version: ref.version,
  })
  delete args.decision_id
  delete args.user_choice
  delete args.approved
  return args
}

// 已核验基线的事后核验载荷（原路径 vs 冻结副本逐字节比对）
function verifyPayloadOf(ref) {
  const copyPath = String(ref.artifact_path)
  const slash = copyPath.lastIndexOf('/')
  return { mode: 'verify', source: String(ref.source_path), copy_dir: slash > 0 ? copyPath.slice(0, slash) : copyPath }
}

// 核验结果 → 基线冲突判定（原路径改写/缺失或证据缺失一律冲突，不把证据缺失包装为成功）
function conflictOf(vb, ref, producerNode) {
  if (!vb || vb.ok !== true || vb.conflict === true) {
    const detailCode = String((vb && vb.code) || 'VERIFY_FAILED')
    const entry = 'wf_run entry=' + producerNode
    return {
      code: 'EVALUATION_BASELINE_CONFLICT',
      detail_code: detailCode,
      expected: vb && vb.expected !== undefined ? vb.expected : null,
      observed: vb && vb.observed !== undefined ? vb.observed : null,
      message: '活动评价基线 v' + ref.version + ' 核验冲突（' + detailCode + '）：原评价文件与冻结副本不一致或核验证据缺失；冻结副本已保留。',
      recovery_hint: '从确认节点重新确认产生新版本评价基线（' + entry + '）',
    }
  }
  return null
}

module.exports = {
  snippetSource,
  parseFreezeRequest,
  freezePayload,
  parseSubprocessJson,
  gateBlockOf,
  baselineRefOf,
  resumeArgsOf,
  verifyPayloadOf,
  conflictOf,
}
