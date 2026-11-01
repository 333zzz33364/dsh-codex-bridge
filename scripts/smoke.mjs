/**
 * 冒烟测试：不启动 dsh 也能验证核心逻辑。
 *   node scripts/smoke.mjs            只测额度（不花 token）
 *   node scripts/smoke.mjs --image    连出图一起测（会消耗订阅额度）
 */
import path from 'node:path'

import { findCodex } from '../lib/generate.js'
import { fetchQuota, quotaText } from '../lib/quota.js'
import { monthDir } from '../lib/config.js'

const wantImage = process.argv.includes('--image')

console.log('codex.exe：', findCodex() || '没找到')
console.log('输出目录：', monthDir())

const q = await fetchQuota()
console.log('\n=== 额度 ===')
console.log(quotaText(q))

if (wantImage) {
  const { generateWithCodex } = await import('../lib/generate.js')
  console.log('\n=== 出图 ===')
  const r = await generateWithCodex({
    prompt: '一只橘猫趴在木桌上打哈欠，午后阳光，写实照片',
    aspect: '1:1',
    outDir: monthDir(),
    timeoutSec: 240,
  })
  console.log('文件：', r.files[0])
  console.log('用时：', r.seconds, '秒')
  console.log('用量：', r.usage)
}
