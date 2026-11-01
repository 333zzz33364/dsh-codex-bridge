/**
 * dsh-codex-bridge —— 宿主半。
 *
 *   codex_image   模型调用：借 Codex 内置 image_gen 出图（吃 ChatGPT 订阅额度，不需要 API Key）
 *   codex_quota   模型调用：查 5 小时 / 每周窗口还剩多少
 *   webServer     /api/codex-bridge/*，给设置页面板读额度和改配置
 *
 * 刻意不注入 systemPrompt：说明都写在工具描述里，少占一点上下文。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { readAuth } from './auth.js'
import { DEFAULT_CONFIG, ensureDirs, getConfig, loadConfig, monthDir, saveConfig } from './config.js'
import { findCodex, generateWithCodex, isBusy } from './generate.js'
import { fetchQuota, quotaText } from './quota.js'

export const name = 'codex-bridge'
export const inject = ['tools', 'webServer']

const API_PREFIX = '/api/codex-bridge'

const IMAGE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: '画面描述：谁在哪里、做什么、什么气氛。写得具体，别写成关键词堆。' },
    aspect: { type: 'string', description: '画幅：1:1 / 4:3 / 3:4 / 16:9 / 9:16，不填用设置里的默认。' },
    style: { type: 'string', description: '可选的画风或补充要求，如「写实照片质感」「吉卜力风格」「负片色调」。' },
    caption: { type: 'string', description: '可选：图下面那句配图说明。' },
  },
}

const QUOTA_PARAMS = { type: 'object', additionalProperties: false, properties: {} }

const LOOSE = { type: 'object', additionalProperties: true }

function maskFile(p) {
  return typeof p === 'string' ? p : ''
}

export function apply(ctx) {
  ensureDirs()
  loadConfig()

  const logger = (() => {
    try { return typeof ctx.logger === 'function' ? ctx.logger('codex-bridge') : ctx.logger } catch { return null }
  })()
  const log = (level, msg) => { try { logger?.[level]?.(msg) } catch {} }

  const register = (def) => {
    try { return ctx.tools.register(def) }
    catch (error) {
      if (error instanceof Error && /already|duplicate|exists/i.test(error.message)) {
        log('warn', `codex-bridge: 工具 ${def.name} 已注册，跳过`)
        return () => {}
      }
      throw error
    }
  }

  // ---- 工具：codex_image ------------------------------------------------------
  register({
    name: 'codex_image',
    description: '用本机 Codex 的 ChatGPT 订阅额度生成一张图（不走任何 API Key）。慢（约 30–60 秒）、每张会吃掉一点订阅窗口，所以只在用户明确要图、或确实需要一张图时用。要换成付费生图接口就用 image_generate。',
    parameters: IMAGE_PARAMS,
    output: {
      schema: LOOSE,
      render(_args, value) {
        const v = value && typeof value === 'object' ? value : {}
        if (!v.ok) return [{ type: 'text', text: String(v.message || '没有生成图片。') }]
        const u = v.usage || {}
        const bits = [`用时 ${v.seconds} 秒`]
        if (u.input_tokens) bits.push(`输入 ${u.input_tokens}${u.cached_input_tokens ? `（缓存 ${u.cached_input_tokens}）` : ''}`)
        const lines = [
          `已生成图片（${bits.join(' · ')}），已经显示在对话里。`,
          `文件：${v.path}`,
        ]
        if (v.caption) lines.push(`配图说明：${v.caption}`)
        return [
          { type: 'text', text: lines.join('\n') },
          ...(Array.isArray(v.attachments) ? v.attachments.map((attachment) => ({ type: 'image', attachment })) : []),
        ]
      },
      presentationMeta(_args, value) {
        const v = value && typeof value === 'object' ? value : {}
        return { bridge: 'codex-bridge', ok: v.ok === true, path: maskFile(v.path), seconds: v.seconds || 0 }
      },
    },
    async execute(args, exec) {
      const cfg = getConfig()
      if (!cfg.enabled) return { ok: false, message: 'codex-bridge 已在设置里关掉。' }
      const a = args && typeof args === 'object' ? args : {}
      const prompt = String(a.prompt || '').trim()
      if (!prompt) return { ok: false, message: '没有画面描述，画不出来。' }
      if (isBusy()) return { ok: false, message: '上一张还在画，等它结束再发这张。' }

      try {
        readAuth()
      } catch (e) {
        return { ok: false, message: `codex 登录态不可用：${e.message}` }
      }

      let r
      try {
        r = await generateWithCodex({
          prompt,
          aspect: a.aspect || cfg.aspect,
          style: a.style !== undefined ? a.style : cfg.style,
          codexPath: cfg.codexPath,
          proxy: cfg.proxy,
          timeoutSec: cfg.timeoutSec,
          outDir: monthDir(),
          signal: exec?.signal,
        })
      } catch (e) {
        return { ok: false, message: `出图失败：${e?.message || e}` }
      }

      const value = {
        ok: true,
        path: r.files[0],
        files: r.files,
        seconds: r.seconds,
        usage: r.usage || null,
        caption: typeof a.caption === 'string' ? a.caption : '',
        attachments: [],
      }

      if (cfg.showToModel) {
        try {
          const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
          if (attachments && typeof attachments.saveImages === 'function') {
            const file = r.files[0]
            const refs = await attachments.saveImages([{
              data: readFileSync(file),
              mediaType: 'image/png',
              name: path.basename(file),
            }])
            value.attachments = JSON.parse(JSON.stringify(refs))
          }
        } catch (e) {
          log('warn', `codex-bridge: 附件保存失败，只回文字：${e?.message || e}`)
        }
      }
      return value
    },
  })

  // ---- 工具：codex_quota ------------------------------------------------------
  register({
    name: 'codex_quota',
    description: '查 Codex / ChatGPT 的订阅额度：5 小时窗口和每周窗口各用了多少、什么时候重置、还有几张重置卡。只发一个几百字节的 HTTP 请求，不消耗模型 token。',
    parameters: QUOTA_PARAMS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      try {
        const q = await fetchQuota({ proxy: getConfig().proxy })
        return quotaText(q)
      } catch (e) {
        return `查不到额度：${e?.message || e}`
      }
    },
  })

  // ---- 设置页接口 -------------------------------------------------------------
  const sendJson = (res, status, body) => {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    })
    res.end(bytes)
  }

  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try { resolve(text ? JSON.parse(text) : {}) } catch { resolve({}) }
    })
  })

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname.slice(API_PREFIX.length) || '/'

    try {
      if (req.method === 'GET' && p === '/quota') {
        const q = await fetchQuota({ proxy: getConfig().proxy })
        const { raw, ...rest } = q
        return sendJson(res, 200, { ...rest, text: quotaText(q) })
      }
      if (req.method === 'GET' && p === '/config') {
        const cfg = getConfig()
        return sendJson(res, 200, {
          config: cfg,
          defaults: DEFAULT_CONFIG,
          detected: { codex: findCodex(cfg.codexPath) || '', busy: isBusy() },
        })
      }
      if (req.method === 'POST' && p === '/config') {
        const body = await readBody(req)
        const allowed = Object.keys(DEFAULT_CONFIG)
        const patch = {}
        for (const k of allowed) if (k in body) patch[k] = body[k]
        return sendJson(res, 200, { config: saveConfig(patch) })
      }
      if (req.method === 'POST' && p === '/open-folder') {
        return sendJson(res, 200, { path: monthDir() })
      }
      return sendJson(res, 404, { error: `未知接口 ${p}` })
    } catch (e) {
      return sendJson(res, 500, { error: e?.message || String(e) })
    }
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    return () => { if (typeof dispose === 'function') dispose() }
  }, 'dsh-codex-bridge: http')

  const cfg = getConfig()
  const codex = findCodex(cfg.codexPath)
  let authOk = '未检测'
  try { readAuth(); authOk = '已登录' } catch { authOk = '未登录' }
  log('info', `codex-bridge 已加载：${cfg.enabled ? '开' : '关'} · codex ${codex ? '已找到' : '没找到'} · ChatGPT ${authOk}`)
}
