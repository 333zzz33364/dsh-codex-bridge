/**
 * 把本插件挂进 desktop profile（幂等，改前自动备份）。
 *
 *   node scripts/install.mjs           # 改 package.json 并提示下一步
 *   node scripts/install.mjs --revert  # 改回去
 *
 * 只动两处：dependencies 里加 link:，dsh.profile.bundles 里加名字。
 * cordis.patch.yml 不用改——插件自带的 cordis.patch.yml 会作为 bundle 层 insert。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_NAME = 'dsh-codex-bridge'
// 注意：别用 new URL(...).pathname —— 中文路径会被百分号编码，pnpm 就找不到目录了
const SELF = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const revert = process.argv.includes('--revert')

const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
const profileDir = process.env.DSH_PROFILE_DIR || path.join(home, '.dsh', 'profiles', 'desktop')
const pkgPath = path.join(profileDir, 'package.json')

if (!existsSync(pkgPath)) {
  console.error(`找不到 profile 的 package.json：${pkgPath}`)
  process.exit(1)
}

const raw = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(raw)
pkg.dependencies = pkg.dependencies || {}
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []

const linkTarget = 'link:' + SELF.replace(/\\/g, '/')
const hadDep = Object.prototype.hasOwnProperty.call(pkg.dependencies, PKG_NAME)
const hadBundle = pkg.dsh.profile.bundles.includes(PKG_NAME)

if (revert) {
  if (hadDep) delete pkg.dependencies[PKG_NAME]
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG_NAME)
} else {
  pkg.dependencies[PKG_NAME] = linkTarget
  if (!hadBundle) pkg.dsh.profile.bundles.push(PKG_NAME)
}

const bak = pkgPath + '.bak-codex-bridge'
if (!existsSync(bak)) copyFileSync(pkgPath, bak)
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

console.log(`${revert ? '已移除' : '已写入'} ${pkgPath}`)
console.log(`  dependencies.${PKG_NAME} = ${revert ? '(删除)' : linkTarget}`)
console.log(`  bundles 里${revert ? '已去掉' : hadBundle ? '本来就有' : '已加上'} ${PKG_NAME}`)
console.log('\n下一步：')
console.log(`  cd "${profileDir}"`)
console.log('  pnpm install')
console.log('  然后重启 dsh（或重载 desktop profile）')
console.log(`\n回滚：node scripts/install.mjs --revert && pnpm install（原文件备份在 ${bak}）`)
