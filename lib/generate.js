/**
 * dsh-codex-bridge —— 借 Codex 内置的 image_gen 出图。
 *
 * 做法：spawn 一次 `codex exec --enable image_generation`，让它用 ChatGPT 订阅身份去画；
 * 成品由 codex 落在 ~/.codex/generated_images/<会话>/<调用>.png，这里按「开始前的快照」挑出新增的那张。
 *
 * 省 token 的四个开关（实测 78,567 → 45,809，降 42%，画质不变）：
 *   model_verbosity=low        少说废话
 *   model_reasoning_effort=low 少绕弯
 *   tools.web_search=false     去掉没用的联网工具定义
 *   project_doc_max_bytes=0    不注入 AGENTS.md 等项目文档
 * 再加一条「只做一件事」的提示词，把轮数压到最少。
 */
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { codexHome, resolveProxyAsync } from './auth.js'

let busy = false

export function isBusy() { return busy }

const WIN_PKG = path.join('node_modules', '@openai', 'codex', 'node_modules', '@openai',
  'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')

function readPkgVersion(baseDir) {
  try {
    const f = path.join(baseDir, 'node_modules', '@openai', 'codex', 'package.json')
    return JSON.parse(readFileSync(f, 'utf8')).version || '0'
  } catch (e) {
    if (process.env.CODEX_BRIDGE_DEBUG) {
      try { console.error(`[codex-bridge] 读版本失败 ${baseDir}: ${e.message}`) } catch {}
    }
    return '0'
  }
}

function parseVer(v) {
  return String(v || '0').split('.').map((x) => parseInt(x, 10) || 0)
}

function cmpVer(a, b) {
  const x = parseVer(a)
  const y = parseVer(b)
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  return 0
}

let prefixCache = null
/** npm 全局前缀只解析一次；PATH 里不一定有它（本机就漏了 D:\aidaima\node\global）。 */
function npmGlobalPrefix() {
  if (prefixCache !== null) return prefixCache
  // Windows 上直接 execFile('npm.cmd') 会 EINVAL，得经 cmd.exe 转一手
  const tries = [
    ['cmd.exe', ['/c', 'npm', 'prefix', '-g']],
    ['npm', ['prefix', '-g']],
  ]
  for (const [cmd, args] of tries) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true })
      const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop()
      if (line) { prefixCache = line; return prefixCache }
    } catch {}
  }
  prefixCache = ''
  return prefixCache
}

/**
 * 找 codex.exe：显式配置 → PATH 里各 npm 全局安装 → npm 前缀目录 → ~/.codex/.sandbox-bin 兜底。
 * 候选按 **npm 包版本从高到低** 排，取第一个。
 *
 * 为什么要挑版本：本机装了两份（D:\ai2 是 0.156.1，D:\aidaima 是 0.166.0）。
 * 旧版会被服务端拒绝，报 `The 'xxx' model is not supported when using Codex with a ChatGPT account`；
 * 而 `.sandbox-bin` 那份虽然也是 0.166.0，却缺 codex-code-mode-host.exe，image_gen 起不来。
 */
export function findCodex(explicit) {
  if (explicit) {
    try { if (existsSync(explicit) && statSync(explicit).isFile()) return explicit } catch {}
  }
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)

  const roots = [...dirs]
  const prefix = npmGlobalPrefix()
  if (prefix && !roots.includes(prefix)) roots.push(prefix)
  const nodeDir = path.dirname(process.execPath || '')
  for (const guess of [path.join(nodeDir, 'global'), path.join(nodeDir, '..', 'global')]) {
    if (!roots.includes(guess)) roots.push(guess)
  }

  const cands = []
  for (const d of roots) {
    const exe = path.join(d, WIN_PKG)
    try {
      if (existsSync(exe) && statSync(exe).isFile()) cands.push({ exe, ver: readPkgVersion(d) })
    } catch {}
  }
  if (cands.length === 0) {
    const sb = path.join(home, '.codex', '.sandbox-bin', 'codex.exe')
    try { if (existsSync(sb)) cands.push({ exe: sb, ver: '0' }) } catch {}
  }
  if (cands.length === 0) return null
  cands.sort((a, b) => cmpVer(b.ver, a.ver))
  if (process.env.CODEX_BRIDGE_DEBUG) {
    try { console.error('[codex-bridge] 候选：' + cands.map((c) => `${c.ver} ${c.exe}`).join(' | ')) } catch {}
  }
  return cands[0].exe
}

/** 记下 generated_images 里现有的 png，跑完再比对。 */
function snapshot(genRoot) {
  const seen = new Set()
  const walk = (dir, depth) => {
    if (depth > 3) return
    let items = []
    try { items = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const p = path.join(dir, it.name)
      if (it.isDirectory()) walk(p, depth + 1)
      else if (/\.png$/i.test(it.name)) seen.add(p)
    }
  }
  walk(genRoot, 0)
  return seen
}

function newestNew(genRoot, before, since) {
  let best = null
  const walk = (dir, depth) => {
    if (depth > 3) return
    let items = []
    try { items = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const p = path.join(dir, it.name)
      if (it.isDirectory()) { walk(p, depth + 1); continue }
      if (!/\.png$/i.test(it.name)) continue
      if (before.has(p)) continue
      let st
      try { st = statSync(p) } catch { continue }
      if (st.mtimeMs < since - 5000) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs, size: st.size }
    }
  }
  walk(genRoot, 0)
  return best
}

const ASPECT_HINT = {
  '1:1': '方形构图（1:1）',
  '4:3': '横向构图（4:3）',
  '3:4': '竖向构图（3:4）',
  '16:9': '宽幅横向构图（16:9）',
  '9:16': '竖幅构图（9:16）',
}

function buildPrompt(prompt, aspect, style) {
  const bits = [`只做一件事：调用 image_gen 工具生成一张图片，画面是「${prompt}」。`]
  if (aspect && ASPECT_HINT[aspect]) bits.push(`画面用${ASPECT_HINT[aspect]}。`)
  else if (aspect) bits.push(`画面比例 ${aspect}。`)
  if (style) bits.push(style)
  bits.push('不要读取任何文件，不要解释，不要写代码，不要输出描述文字。生成完立刻结束。')
  return bits.join('')
}

/**
 * @param {{prompt:string, aspect?:string, style?:string, codexPath?:string, proxy?:string,
 *          timeoutSec?:number, outDir:string, signal?:AbortSignal}} opts
 * @returns {Promise<{files:string[], usage:object|null, seconds:number, workDir:string}>}
 */
export async function generateWithCodex(opts) {
  if (busy) {
    const e = new Error('上一张还在画，等它画完再来（codex 同时只能跑一个会话）')
    e.code = 'BUSY'
    throw e
  }
  const codex = findCodex(opts.codexPath)
  if (!codex) {
    const e = new Error('找不到 codex.exe：在插件设置里填绝对路径，或确认 npm 全局装过 @openai/codex')
    e.code = 'NO_CODEX'
    throw e
  }

  const genRoot = path.join(codexHome(), 'generated_images')
  mkdirSync(genRoot, { recursive: true })
  const before = snapshot(genRoot)
  const startedAt = Date.now()
  const timeoutMs = Math.max(30, Number(opts.timeoutSec) || 240) * 1000

  const workDir = path.join(path.dirname(opts.outDir), 'work')
  mkdirSync(workDir, { recursive: true })

  const args = [
    'exec', '--json', '--enable', 'image_generation', '--skip-git-repo-check',
    '-s', 'workspace-write', '-C', workDir,
    '-c', 'model_verbosity="low"',
    '-c', 'model_reasoning_effort="low"',
    '-c', 'tools.web_search=false',
    '-c', 'project_doc_max_bytes=0',
  ]
  const proxy = await resolveProxyAsync(opts.proxy)
  const env = { ...process.env }
  if (proxy) { env.HTTP_PROXY = proxy; env.HTTPS_PROXY = proxy; env.http_proxy = proxy; env.https_proxy = proxy }
  env.RUST_LOG = process.env.CODEX_BRIDGE_LOG || 'error'
  console.log(`[codex-bridge] codex=${codex} proxy=${proxy || '(直连)'}`)

  const text = buildPrompt(opts.prompt, opts.aspect, opts.style)
  const fullArgs = [...args, text]
  const tracePath = path.join(workDir, 'last-run.log')
  let trace = ''
  const traceAdd = (line) => {
    trace += line + '\n'
    if (trace.length > 200000) trace = trace.slice(-150000)
  }

  busy = true

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(codex, fullArgs, { cwd: workDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let usage = null
      let lastMessage = ''
      let errTail = ''
      let finished = false

      let timer = null
      const kill = (why) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        try { child.kill() } catch {}
        reject(why)
      }

      timer = setTimeout(() => kill(Object.assign(new Error(`超过 ${timeoutMs / 1000} 秒还没出图`), { code: 'TIMEOUT' })), timeoutMs)
      const onAbort = () => kill(Object.assign(new Error('已取消'), { code: 'ABORTED' }))
      if (opts.signal) {
        if (opts.signal.aborted) onAbort()
        else opts.signal.addEventListener('abort', onAbort, { once: true })
      }

      let buf = ''
      child.stdout.on('data', (chunk) => {
        const s = chunk.toString('utf8')
        traceAdd(s.trimEnd())
        buf += s
        let at
        while ((at = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, at).trim()
          buf = buf.slice(at + 1)
          if (!line.startsWith('{')) continue
          let ev
          try { ev = JSON.parse(line) } catch { continue }
          if (ev.type === 'turn.completed' && ev.usage) usage = ev.usage
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') lastMessage = ev.item.text || ''
        }
      })
      child.stderr.on('data', (chunk) => {
        const s = chunk.toString('utf8')
        traceAdd('[stderr] ' + s.trimEnd())
        errTail = (errTail + s).slice(-4000)
      })
      child.on('error', (e) => kill(Object.assign(new Error(`启动 codex 失败：${e.message}`), { code: 'SPAWN' })))
      child.on('close', (code) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
        resolve({ code, usage, lastMessage, errTail })
      })
    })

    try { writeFileSync(tracePath, trace, 'utf8') } catch {}

    const shot = newestNew(genRoot, before, startedAt)
    if (!shot) {
      const hint = result.lastMessage ? `codex 说：${result.lastMessage.slice(0, 300)}` : ''
      const err = (result.errTail || '').split('\n').filter((l) => /ERROR|error/i.test(l)).slice(-2).join(' | ')
      const e = new Error(`没等到图片。${hint}${err ? ` ${err.slice(0, 300)}` : ''}`)
      e.code = 'NO_IMAGE'
      throw e
    }

    mkdirSync(opts.outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const dest = path.join(opts.outDir, `codex-${stamp}-${Math.random().toString(36).slice(2, 6)}.png`)
    copyFileSync(shot.path, dest)

    return { files: [dest], source: shot.path, usage: result.usage, seconds: Math.round((Date.now() - startedAt) / 1000), workDir }
  } finally {
    busy = false
  }
}
