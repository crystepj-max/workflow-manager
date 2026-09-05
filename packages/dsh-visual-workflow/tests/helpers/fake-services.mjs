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
export function makeSubprocess({ failPattern = null, fs = null, compileScript = '//MOCK-SCRIPT' } = {}) {
  const calls = []
  const specs = []
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const sub = {
    async resolveExecutable(command) { return '/usr/bin/node' },
    spawn(spec) {
      calls.push(spec.argv)
      specs.push(spec)
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
