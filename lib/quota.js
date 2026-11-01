/**
 * dsh-codex-bridge —— 额度查询。
 *
 * 打的是 codex 自己用的那个接口：GET https://chatgpt.com/backend-api/wham/usage
 *   rate_limit.primary_window    5 小时滚动窗口
 *   rate_limit.secondary_window  7 天窗口
 *   credits                      余额（订阅制通常是 0 / 不适用）
 *   rate_limit_reset_credits     手上还有几张「重置卡」
 *
 * 这个请求只有几百字节，不产生模型 token 消耗。
 */
import { curl, readAuth, resolveProxyAsync } from './auth.js'

const BASE = 'https://chatgpt.com/backend-api'

function baseHeaders(auth) {
  return {
    Authorization: `Bearer ${auth.token}`,
    'chatgpt-account-id': auth.accountId,
    'user-agent': 'Mozilla/5.0 (dsh-codex-bridge)',
    accept: 'application/json',
  }
}

function fmtWindow(w) {
  if (!w || typeof w !== 'object') return null
  const used = Number(w.used_percent) || 0
  const spanMin = Number(w.limit_window_seconds) || 0
  return {
    usedPercent: used,
    remainPercent: Math.max(0, 100 - used),
    windowMinutes: Math.round(spanMin / 60),
    resetsAt: Number(w.reset_at) || 0,
    resetInSeconds: Number(w.reset_after_seconds) || 0,
    windowLabel: spanMin >= 172800 ? `${Math.round(spanMin / 86400)} 天` : `${Math.round(spanMin / 3600)} 小时`,
  }
}

export async function fetchQuota({ proxy } = {}) {
  const auth = readAuth()
  const px = await resolveProxyAsync(proxy)
  const res = await curl(`${BASE}/wham/usage`, { headers: baseHeaders(auth), proxy: px, timeout: 25 })
  if (res.status === 401) {
    const e = new Error('token 已过期：随便跑一次 codex（或 `codex login`）会续期，再刷新')
    e.code = 'EXPIRED'
    throw e
  }
  if (res.status !== 200) {
    const e = new Error(`额度接口返回 HTTP ${res.status}${res.body ? `：${res.body.slice(0, 200)}` : ''}`)
    e.code = 'HTTP'
    throw e
  }
  let j
  try { j = JSON.parse(res.body) } catch { throw new Error('额度接口返回的不是 JSON') }

  const primary = fmtWindow(j?.rate_limit?.primary_window)
  const secondary = fmtWindow(j?.rate_limit?.secondary_window)
  return {
    ok: true,
    fetchedAt: Date.now(),
    email: j?.email || '',
    planType: j?.plan_type || '',
    limitReached: j?.rate_limit?.limit_reached === true,
    primary,
    secondary,
    credits: {
      hasCredits: j?.credits?.has_credits === true,
      unlimited: j?.credits?.unlimited === true,
      balance: j?.credits?.balance ?? '0',
    },
    resetCards: Number(j?.rate_limit_reset_credits?.available_count) || 0,
    raw: j,
  }
}

function pct(n) {
  return `${Math.round(n)}%`
}

function when(ts) {
  if (!ts) return '未知'
  const d = new Date(ts * 1000)
  const pad = (x) => String(x).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 给模型看的一行摘要；工具返回值用这个。 */
export function quotaText(q) {
  const lines = [
    `套餐 ${q.planType || '未知'}${q.email ? `（${q.email}）` : ''}`,
    q.primary ? `5 小时窗口：已用 ${pct(q.primary.usedPercent)}，剩 ${pct(q.primary.remainPercent)}，${when(q.primary.resetsAt)} 重置` : null,
    q.secondary ? `每周窗口：已用 ${pct(q.secondary.usedPercent)}，剩 ${pct(q.secondary.remainPercent)}，${when(q.secondary.resetsAt)} 重置` : null,
    `重置卡 ${q.resetCards} 张${q.credits.unlimited ? '；credits 无限' : `；credits 余额 ${q.credits.balance}`}`,
    q.limitReached ? '当前已被限流' : null,
  ].filter(Boolean)
  return lines.join('\n')
}
