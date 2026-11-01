/**
 * dsh-codex-bridge —— 认证与网络。
 *
 * 只读 ~/.codex/auth.json：Codex 用 ChatGPT 账号登录时，里面是 access_token + account_id，
 * 不需要任何 API Key。token 过期后跑一次 codex 会自动续，所以这里只判断「有没有、长什么样」。
 *
 * 访问 chatgpt.com 要走本机代理，所以统一用 curl.exe（Windows 10 1803+ 自带），
 * 避免为代理去引第三方依赖。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export function codexHome() {
  const env = process.env.CODEX_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.codex')
}

export function authPath() {
  return path.join(codexHome(), 'auth.json')
}

export function readAuth() {
  const f = authPath()
  if (!existsSync(f)) {
    const e = new Error(`找不到 ${f}：先在本机用 ChatGPT 账号登录一次 codex`)
    e.code = 'NO_AUTH'
    throw e
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'))
  } catch (err) {
    const e = new Error(`auth.json 不是合法 JSON：${err.message}`)
    e.code = 'BAD_AUTH'
    throw e
  }
  if (raw?.auth_mode !== 'chatgpt' || !raw?.tokens?.access_token) {
    const e = new Error(`auth.json 不是 chatgpt 登录模式（当前 ${raw?.auth_mode || '未知'}），这条路需要 ChatGPT 登录`)
    e.code = 'BAD_AUTH'
    throw e
  }
  return {
    token: raw.tokens.access_token,
    accountId: raw.tokens.account_id || '',
    lastRefresh: raw.last_refresh || '',
  }
}

/** 代理：显式配置优先，其次环境变量；空字符串表示继续往探测走。 */
export function resolveProxy(configured) {
  const c = typeof configured === 'string' ? configured.trim() : ''
  if (c) return c
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || ''
}

const LOCAL_PROXY_PORTS = [20890, 7890, 7897, 10809, 1080]

function probePort(port, timeout = 350) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolve(ok)
    }
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 配置和环境都没有时，探一下本机常见代理端口。
 * 这一步很要紧：codex 连不上网就刷不到可用模型列表，会退回到 config.toml 里那个
 * 「桌面版专用」模型（如 gpt-6.1-sol），服务端直接 400 model_not_found。
 */
export async function resolveProxyAsync(configured) {
  const direct = resolveProxy(configured)
  if (direct) return direct
  for (const port of LOCAL_PROXY_PORTS) {
    if (await probePort(port)) return `http://127.0.0.1:${port}`
  }
  return ''
}

/** 用 curl 发一次请求，返回 { status, body }。body 已按 utf8 解码。 */
export function curl(url, { headers = {}, proxy = '', timeout = 25, method = 'GET', body = '' } = {}) {
  const args = ['-s', '-m', String(timeout), '-o', '-', '-w', '\n__STATUS__%{http_code}', '--url', url]
  if (proxy) args.unshift('-x', proxy)
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`)
  if (method && method !== 'GET') args.push('-X', method)
  if (body) args.push('--data-binary', body)

  return new Promise((resolve, reject) => {
    execFile('curl.exe', args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return reject(new Error(`curl 调用失败：${err.message}`))
      const text = String(stdout)
      const at = text.lastIndexOf('__STATUS__')
      if (at < 0) return reject(new Error('curl 没有返回状态码'))
      const status = Number(text.slice(at + 10).trim()) || 0
      resolve({ status, body: text.slice(0, at).replace(/\n$/, '') })
    })
  })
}
