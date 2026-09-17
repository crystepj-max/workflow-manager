// 共享假服务（候选一 T-IMP-12：host.test.mjs 与统一编译器验收套件共用）
// 与宿主 fs/subprocess/sandboxPolicy 服务同形；makeSubprocess 支持
// compileScript 分支（模拟 generate.mjs compile 子命令输出）。
export const REPO = '/repo'
export const SESSION_REPO = '/session/workspace'
export const HOME = '/Users/tester'
export const DSH_HOME = HOME + '/.dsh'
export const USER_DIR = DSH_HOME + '/visual-workflow/templates'
export const SKILL_ROOT = DSH_HOME + '/skills'

// 假 fs：内存 Map（与宿主 fs 服务同形）
export function makeFs(seed = {}) {
  const files = new Map(Object.entries(seed))
  const target = (path) => ({ targetKey: path, displayPath: path })
  const fs = {
    async resolve(path) { return target(path) },
    async stat(t) {
      const p = t.displayPath || t.targetKey
      if (files.has(p)) return { version: 'v' + files.get(p).length, type: 'file' }
      for (const k of files.keys()) if (k.startsWith(p + '/')) return { version: 'd', type: 'directory' }
      return undefined
    },
    async readText(t) {
      const p = t.displayPath || t.targetKey
      if (!files.has(p)) throw new Error('ENOENT ' + p)
      return files.get(p)
    },
    async writeText(t, content) {
      const p = t.displayPath || t.targetKey
      files.set(p, content)
      return { version: 'v' + content.length }
    },
    async listDir(t) {
      const p = t.displayPath || t.targetKey
      const kids = new Map()
      for (const k of files.keys()) {
        if (!k.startsWith(p + '/')) continue
        const first = k.slice(p.length + 1).split('/')[0]
        if (!kids.has(first)) {
          kids.set(first, { name: first, type: files.has(p + '/' + first) ? 'file' : 'directory', target: target(p + '/' + first) })
        }
      }
      return [...kids.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    _files: files,
  }
  return fs
}

// failPattern：argv 字符串匹配则模拟生成器失败（exit 1 + 蓝图校验错误）
// fs：传入时模拟 rmSync 真实删除（remove/回滚/临时蓝图清理路径）
// compileScript：generate.mjs compile 子命令的模拟输出（统一编译器管道）
// recordsHost / wsHost / operationsHost / deliveryCloseoutHost：records-host.mjs /
// workspace-isolation-host.mjs / operations-host.mjs（LOC-032）/ delivery-closeout-host.mjs
//（LOC-037）的进程边界替身——宿主侧接线测试可借此驱动真实包装脚本逻辑（仅伪造进程边界，不伪造内核）。
// spawnHandler：可选自定义进程边界（spec => { stdout, exitCode, stderr } | undefined），
// 返回 undefined 走默认分支；LOC-027 基线冻结/核验用真实 node 子进程验证字节语义。
export function makeSubprocess({ failPattern = null, fs = null, compileScript = '//MOCK-SCRIPT', recordsHost = null, wsHost = null, operationsHost = null, deliveryCloseoutHost = null, spawnHandler = null } = {}) {
  const calls = []
  const specs = []
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const hostCall = (fn, spec) => {
    const cmd = spec.argv[spec.argv.length - 2]
    let input = {}
    try { input = JSON.parse(spec.argv[spec.argv.length - 1]) } catch (e) { /* 空输入 */ }
    // 真实 wrapper 契约：业务结果（含 ok:false）一律 exit 0 + stdout 整包；只有
    // 命令内部抛异常才是 exit 1（stderr 承载错误）。宿主侧按 parsed.ok 分流。
    try {
      const out = fn(cmd, input, spec)
      if (out === undefined) return { stdout: '', exitCode: 0 }
      return { stdout: JSON.stringify(out), exitCode: 0 }
    } catch (e) {
      return { stdout: '', exitCode: 1, stderr: String((e && e.message) || e) }
    }
  }
  const sub = {
    async resolveExecutable(command) { return '/usr/bin/node' },
    spawn(spec) {
      calls.push(spec.argv)
      specs.push(spec)
      if (spawnHandler) {
        const handled = spawnHandler(spec)
        if (handled) return {
          pid: 1,
          done: Promise.resolve({ exitCode: handled.exitCode === undefined ? 0 : handled.exitCode, signal: null }),
          collected: { stdout: reader(handled.stdout || ''), stderr: reader(handled.stderr || '') },
          terminate() {},
          waitForExit: async () => true,
        }
      }
      const argvStr = spec.argv.join(' ')
      let exitCode = 0
      let stdout = ''
      let stderr = ''
      if (argvStr.includes('validate-core.cjs') && fs) {
        const key = [...fs._files.keys()].find((k) => k.endsWith('/validate-core.cjs'))
        if (key) stdout = fs._files.get(key)
        else exitCode = 2
      } else if (argvStr.includes('.homedir')) {
        stdout = DSH_HOME
      } else if (argvStr.includes('generate.mjs') && argvStr.includes(' compile ')) {
        stdout = JSON.stringify({ ok: true, script: compileScript, meta: { name: 'mock', description: 'mock', phases: [] } })
      } else if (argvStr.includes('records-host.mjs') && recordsHost) {
        ;({ stdout, exitCode } = hostCall(recordsHost, spec))
      } else if (argvStr.includes('operations-host.mjs') && operationsHost) {
        ;({ stdout, exitCode } = hostCall(operationsHost, spec))
      } else if (argvStr.includes('delivery-closeout-host.mjs') && deliveryCloseoutHost) {
        ;({ stdout, exitCode } = hostCall(deliveryCloseoutHost, spec))
      } else if (argvStr.includes('workspace-isolation-host.mjs') && wsHost) {
        ;({ stdout, exitCode } = hostCall(wsHost, spec))
      } else if (argvStr.includes('rmSync')) {
        if (fs) fs._files.delete(spec.argv[spec.argv.length - 1])
      } else if (failPattern && failPattern.test(argvStr)) {
        exitCode = 1
        stderr = '❌ 蓝图校验失败：$.id 测试错误'
      }
      return {
        pid: 1,
        done: Promise.resolve({ exitCode, signal: null }),
        collected: { stdout: reader(stdout), stderr: reader(stderr) },
        terminate() {},
        waitForExit: async () => true,
      }
    },
    _calls: calls,
    _specs: specs,
  }
  return sub
}

export const sandboxPolicy = { workspaceRoot: REPO, resolve: () => ({ mode: 'danger-full-access', workspaceRoot: REPO }) }
