/**
 * 加载期冒烟：用假的 ctx 调 apply()，确认插件装配不抛错。
 *   node scripts/loadtest.mjs
 * 只验证注册流程，不启动 HTTP、不调用 codex。
 */
const tools = []
let httpRegistered = null

const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  tools: { register: (def) => { tools.push(def); return () => {} } },
  webServer: { register: (def) => { httpRegistered = def; return () => {} } },
  effect(fn, label) { const d = fn(); return d },
  get: () => undefined,
}

const mod = await import('../lib/index.js')
console.log('name =', mod.name, '| inject =', JSON.stringify(mod.inject))

mod.apply(ctx)

console.log('注册的工具：', tools.map((t) => t.name).join(', '))
for (const t of tools) {
  const req = t.parameters?.required || []
  console.log(`  - ${t.name}: required=[${req.join(',')}] render=${typeof t.output?.render}`)
}
console.log('HTTP prefix：', httpRegistered?.path || '(未注册)')

// 额度工具真跑一次（只发一个 HTTP 请求，不花 token）
const quota = tools.find((t) => t.name === 'codex_quota')
if (quota) {
  const out = await quota.execute({}, {})
  console.log('--- codex_quota 返回 ---')
  console.log(out)
}
