/**
 * dsh-codex-bridge —— 配置与目录。
 *
 * 落在 <DSH_HOME>/codex-bridge/
 *   config.json   插件配置（不含任何密钥：身份直接用 ~/.codex/auth.json）
 *   outputs/      生成的图（按 YYYY-MM 分目录）
 *   work/         给 codex 用的可写工作目录
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh')
}

let rootOverride = ''
export function __setRootForTest(dir) { rootOverride = dir }

export function bridgeRoot() { return rootOverride || path.join(dshHome(), 'codex-bridge') }
export function configPath() { return path.join(bridgeRoot(), 'config.json') }
export function outputsRoot() { return path.join(bridgeRoot(), 'outputs') }
export function monthDir(d = new Date()) {
  const pad = (x) => String(x).padStart(2, '0')
  return path.join(outputsRoot(), `${d.getFullYear()}-${pad(d.getMonth() + 1)}`)
}

export const DEFAULT_CONFIG = {
  enabled: true,
  codexPath: '',
  proxy: '',
  timeoutSec: 240,
  aspect: '1:1',
  style: '',
  showToModel: true,
  quotaCacheSec: 30,
}

let current = null

export function loadConfig() {
  if (current) return current
  let raw = {}
  try {
    if (existsSync(configPath())) raw = JSON.parse(readFileSync(configPath(), 'utf8')) || {}
  } catch { raw = {} }
  current = { ...DEFAULT_CONFIG, ...raw }
  // 兼容：早期版本没有的字段补默认
  for (const k of Object.keys(DEFAULT_CONFIG)) if (current[k] === undefined) current[k] = DEFAULT_CONFIG[k]
  return current
}

export function getConfig() { return current || loadConfig() }

export function saveConfig(patch) {
  const next = { ...getConfig(), ...(patch || {}) }
  mkdirSync(bridgeRoot(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  current = next
  return next
}

export function ensureDirs() {
  mkdirSync(bridgeRoot(), { recursive: true })
  mkdirSync(outputsRoot(), { recursive: true })
  mkdirSync(monthDir(), { recursive: true })
  mkdirSync(path.join(bridgeRoot(), 'work'), { recursive: true })
}
