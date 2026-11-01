/**
 * dsh-codex-bridge —— 浏览器半侧（手写 __ModuleLoader__ bundle，不需要构建工具）。
 *
 *   设置 → Codex 生图（slot: settings.section）
 *     额度：5 小时窗口 / 每周窗口的进度、重置时间、重置卡张数
 *     设置：开关、默认画幅、风格、超时、codex 路径、代理
 *
 * 只走同源 fetch（/api/codex-bridge/*），与宿主不共享任何模块。
 * 改完用 `node --check lib/client.js` 验语法。
 */

window.__ModuleLoader__.load({
  id: 'dsh-codex-bridge',
  factory: function (require) {
    var module = { exports: {} }

    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useState = React.useState

    var API = '/api/codex-bridge'
    var NS = 'dsh-codex-bridge'

    var CSS = [
      '.cb-wrap{display:flex;flex-direction:column;gap:16px;font-size:13px}',
      '.cb-card{border:1px solid var(--dsh-border,rgba(128,128,128,.25));border-radius:10px;padding:14px 16px;background:var(--dsh-surface,rgba(128,128,128,.06))}',
      '.cb-card h4{margin:0 0 10px;font-size:13px;font-weight:600;letter-spacing:.02em}',
      '.cb-row{display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap}',
      '.cb-label{min-width:104px;color:var(--dsh-text-weak,rgba(128,128,128,.9))}',
      '.cb-bar{position:relative;flex:1;min-width:160px;height:9px;border-radius:5px;background:rgba(128,128,128,.22);overflow:hidden}',
      '.cb-bar i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#4ea1ff,#3d7ef0)}',
      '.cb-bar.warn i{background:linear-gradient(90deg,#f0a53d,#e2761b)}',
      '.cb-bar.danger i{background:linear-gradient(90deg,#ef5b5b,#c62c2c)}',
      '.cb-num{font-variant-numeric:tabular-nums;min-width:96px;text-align:right;color:var(--dsh-text,rgba(220,220,220,.95))}',
      '.cb-hint{color:var(--dsh-text-weak,rgba(128,128,128,.9));font-size:12px;line-height:1.6}',
      '.cb-btn{border:1px solid var(--dsh-border,rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer}',
      '.cb-btn:hover{background:rgba(128,128,128,.12)}',
      '.cb-btn.primary{border-color:#3d7ef0;background:#3d7ef0;color:#fff}',
      '.cb-btn:disabled{opacity:.5;cursor:default}',
      '.cb-input{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:7px;border:1px solid var(--dsh-border,rgba(128,128,128,.35));background:var(--dsh-input,rgba(0,0,0,.12));color:inherit;font-size:12px}',
      '.cb-field{display:flex;flex-direction:column;gap:5px;margin:10px 0;max-width:520px}',
      '.cb-field > span{font-size:12px;color:var(--dsh-text-weak,rgba(128,128,128,.9))}',
      '.cb-err{color:#d9534f;font-size:12px}',
      '.cb-ok{color:#3c9a5f;font-size:12px}',
    ].join('\n')

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var err = new Error((data && data.error) || ('HTTP ' + res.status))
          err.status = res.status
          throw err
        }
        return data
      })
    }

    function apiGet(p) { return fetch(API + p, { cache: 'no-store' }).then(readJson) }
    function apiPost(p, body) {
      return fetch(API + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function pct(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—'
      return Math.round(n) + '%'
    }

    function when(ts) {
      if (!ts) return '—'
      var d = new Date(ts * 1000)
      function p2(x) { return x < 10 ? '0' + x : String(x) }
      return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
    }

    function Bar(props) {
      var used = typeof props.used === 'number' ? Math.max(0, Math.min(100, props.used)) : 0
      var cls = 'cb-bar' + (used >= 90 ? ' danger' : used >= 70 ? ' warn' : '')
      return h('div', { className: cls }, h('i', { style: { width: used + '%' } }))
    }

    function QuotaRow(props) {
      var w = props.window
      if (!w) return null
      return h('div', { className: 'cb-row' }, [
        h('span', { className: 'cb-label', key: 'l' }, props.label),
        h(Bar, { key: 'b', used: w.usedPercent }),
        h('span', { className: 'cb-num', key: 'n' }, '已用 ' + pct(w.usedPercent) + ' · 剩 ' + pct(w.remainPercent)),
        h('span', { className: 'cb-hint', key: 'r' }, when(w.resetsAt) + ' 重置'),
      ])
    }

    function Section(props) {
      var _q = useState(null)
      var quota = _q[0]
      var setQuota = _q[1]
      var _e = useState('')
      var error = _e[0]
      var setError = _e[1]
      var _c = useState(null)
      var cfg = _c[0]
      var setCfg = _c[1]
      var _d = useState(null)
      var detected = _d[0]
      var setDetected = _d[1]
      var _l = useState(false)
      var loading = _l[0]
      var setLoading = _l[1]
      var _s = useState('')
      var saved = _s[0]
      var setSaved = _s[1]

      var loadQuota = useCallback(function () {
        setLoading(true)
        setError('')
        return apiGet('/quota')
          .then(function (q) { setQuota(q) })
          .catch(function (e) { setError(e.message || String(e)) })
          .then(function () { setLoading(false) })
      }, [])

      useEffect(function () {
        apiGet('/config').then(function (r) {
          setCfg(r.config)
          setDetected(r.detected || null)
        }).catch(function (e) { setError(e.message || String(e)) })
        loadQuota()
      }, [])

      var update = function (key, value) {
        setCfg(function (old) {
          var next = {}
          for (var k in old) next[k] = old[k]
          next[key] = value
          return next
        })
        setSaved('')
      }

      var save = function () {
        apiPost('/config', cfg).then(function (r) {
          setCfg(r.config)
          setSaved('已保存')
          setTimeout(function () { setSaved('') }, 2400)
        }).catch(function (e) { setError(e.message || String(e)) })
      }

      if (!cfg) {
        return h('div', { className: 'cb-wrap' },
          h('div', { className: 'cb-hint' }, error ? ('读取配置失败：' + error) : '载入中…'))
      }

      var children = []

      // 额度卡
      children.push(h('div', { className: 'cb-card', key: 'quota' }, [
        h('h4', { key: 't' }, 'ChatGPT 订阅额度'),
        quota
          ? h('div', { key: 'body' }, [
              h('div', { className: 'cb-row', key: 'plan' },
                h('span', { className: 'cb-label' }, '套餐'),
                h('span', null, (quota.planType || '未知') + (quota.email ? ' · ' + quota.email : ''))),
              h(QuotaRow, { key: 'p', label: '5 小时窗口', window: quota.primary }),
              h(QuotaRow, { key: 's', label: '每周窗口', window: quota.secondary }),
              h('div', { className: 'cb-row', key: 'cards' },
                h('span', { className: 'cb-label' }, '重置卡'),
                h('span', null, (quota.resetCards || 0) + ' 张'),
                h('span', { className: 'cb-hint' }, quota.limitReached ? '（当前已被限流）' : '')),
            ])
          : h('div', { className: 'cb-hint', key: 'none' }, loading ? '正在查…' : '还没查到'),
        error ? h('div', { className: 'cb-err', key: 'err' }, error) : null,
        h('div', { className: 'cb-row', key: 'actions' },
          h('button', { className: 'cb-btn', onClick: loadQuota, disabled: loading }, loading ? '查询中…' : '刷新额度')),
        h('div', { className: 'cb-hint', key: 'note' },
          '这套额度跟 codex 自己用的是同一个池子；查额度只发一个几百字节的请求，不消耗模型 token。'),
      ]))

      // 设置卡
      children.push(h('div', { className: 'cb-card', key: 'settings' }, [
        h('h4', { key: 't' }, '生图设置'),
        h('div', { className: 'cb-row', key: 'enabled' },
          h('label', null,
            h('input', {
              type: 'checkbox',
              checked: cfg.enabled !== false,
              onChange: function (e) { update('enabled', e.target.checked) },
            }),
            ' 允许模型调用 codex_image')),
        h('div', { className: 'cb-field', key: 'aspect' }, [
          h('span', { key: 'l' }, '默认画幅'),
          h('select', {
            className: 'cb-input',
            key: 'i',
            value: cfg.aspect || '1:1',
            onChange: function (e) { update('aspect', e.target.value) },
          }, ['1:1', '4:3', '3:4', '16:9', '9:16'].map(function (a) {
            return h('option', { key: a, value: a }, a)
          })),
        ]),
        h('div', { className: 'cb-field', key: 'style' }, [
          h('span', { key: 'l' }, '默认补充要求（可留空）'),
          h('input', {
            className: 'cb-input',
            key: 'i',
            value: cfg.style || '',
            placeholder: '如：写实照片质感、浅景深',
            onChange: function (e) { update('style', e.target.value) },
          }),
        ]),
        h('div', { className: 'cb-field', key: 'timeout' }, [
          h('span', { key: 'l' }, '单张超时（秒）'),
          h('input', {
            className: 'cb-input',
            key: 'i',
            type: 'number',
            min: 30,
            max: 900,
            value: cfg.timeoutSec || 240,
            onChange: function (e) { update('timeoutSec', Number(e.target.value) || 240) },
          }),
        ]),
        h('div', { className: 'cb-field', key: 'codex' }, [
          h('span', { key: 'l' }, 'codex.exe 路径（留空自动找）'),
          h('input', {
            className: 'cb-input',
            key: 'i',
            value: cfg.codexPath || '',
            placeholder: detected && detected.codex ? detected.codex : '自动探测',
            onChange: function (e) { update('codexPath', e.target.value) },
          }),
        ]),
        h('div', { className: 'cb-field', key: 'proxy' }, [
          h('span', { key: 'l' }, '代理（留空则沿用环境变量）'),
          h('input', {
            className: 'cb-input',
            key: 'i',
            value: cfg.proxy || '',
            placeholder: 'http://127.0.0.1:20890',
            onChange: function (e) { update('proxy', e.target.value) },
          }),
        ]),
        h('div', { className: 'cb-row', key: 'show' },
          h('label', null,
            h('input', {
              type: 'checkbox',
              checked: cfg.showToModel !== false,
              onChange: function (e) { update('showToModel', e.target.checked) },
            }),
            ' 生成后把图也给模型看（关掉能省一点上下文）')),
        h('div', { className: 'cb-row', key: 'save' }, [
          h('button', { className: 'cb-btn primary', key: 'b', onClick: save }, '保存'),
          saved ? h('span', { className: 'cb-ok', key: 'ok' }, saved) : null,
        ]),
      ]))

      // 说明卡
      children.push(h('div', { className: 'cb-card', key: 'about' }, [
        h('h4', { key: 't' }, '它是什么'),
        h('div', { className: 'cb-hint', key: 'b' }, [
          h('div', { key: '1' }, '身份直接读 ~/.codex/auth.json 里的 ChatGPT 登录态，不需要任何 API Key。'),
          h('div', { key: '2' }, '出图走 codex 内置的 image_gen，吃的是你 ChatGPT 订阅的额度，不是 API 账单。'),
          h('div', { key: '3' }, '单张约 4–5 万 token（已开省 token 开关，比默认少约四成），慢 30–60 秒。'),
          h('div', { key: '4' }, '同一时间只能跑一张；点聊天里的停止会顺手把 codex 进程杀掉。'),
        ]),
        detected ? h('div', { className: 'cb-hint', key: 'det' },
          '探测结果：codex ' + (detected.codex || '没找到') + (detected.busy ? ' · 正在画' : '')) : null,
      ]))

      return h('div', { className: 'cb-wrap' }, children)
    }

    function Boundary(props) {
      var _s = useState(null)
      var err = _s[0]
      var setErr = _s[1]
      if (err) {
        return h('div', { className: 'cb-err' }, 'Codex 生图面板出错了：' + String(err.message || err))
      }
      try {
        return props.children
      } catch (e) {
        setErr(e)
        return null
      }
    }

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-codex-bridge-styles'
        var style = document.getElementById(id)
        if (style === null) {
          style = document.createElement('style')
          style.id = id
          style.setAttribute('data-plugin', 'dsh-codex-bridge')
          document.head.appendChild(style)
        }
        style.textContent = CSS
        return function () {
          var el = document.getElementById(id)
          if (el && el.parentNode) el.parentNode.removeChild(el)
        }
      }, 'dsh-codex-bridge: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'codex-bridge',
          order: 49,
          locale: NS,
          label: function () { return '19. Codex 生图' },
        }, function (props) { return h(Boundary, null, h(Section, props || {})) })
      })
    }

    module.exports = {
      name: 'codex-bridge',
      inject: ['slots'],
      apply: apply,
      __test: { Section: Section, Boundary: Boundary },
    }
    return module.exports
  },
})
