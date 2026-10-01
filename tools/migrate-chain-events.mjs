#!/usr/bin/env node
/**
 * 认知链事件账本迁移 · CLI
 *
 * 用法：
 *   node tools/migrate-chain-events.mjs <数据目录> <themeId|--all> [--dry-run]
 *
 * - 把 theme.chain.segments / branch / lemma 翻译成追加式事件（见 chain-events.js）。
 * - --dry-run：只构造事件并校验，不写账本。
 * - 真实账本操作前，请先在拷贝目录上跑 --dry-run 并检查报告。
 */
import { join } from 'node:path'

const [, , dataDir, themeArg, flag] = process.argv
if (!dataDir || !themeArg) {
  console.error('用法：node tools/migrate-chain-events.mjs <数据目录> <themeId|--all> [--dry-run]')
  process.exit(1)
}
process.env.MERIDIAN_USER_DATA_DIR = join(process.cwd(), dataDir)

const store = await import('../src/main/store.js')
const { migrateThemeToEvents, verifyChain, getEvents } = await import('../src/main/chain-events.js')

store.load()
const dryRun = flag === '--dry-run'
const themeIds = themeArg === '--all'
  ? store.load().themes.filter((t) => !t.deletedAt).map((t) => t.id)
  : [themeArg]

for (const themeId of themeIds) {
  const theme = store.load().themes.find((t) => t.id === themeId)
  console.log(`\n主题 ${themeId}（${theme ? theme.name : '不存在'}）${dryRun ? '[dry-run]' : ''}`)
  try {
    const { created, skipped, report } = migrateThemeToEvents(themeId, { persist: !dryRun })
    console.log(`  新建事件 ${created}，跳过（已存在）${skipped}`)
    console.log(`  覆盖：${JSON.stringify(report)}`)
    if (!dryRun) {
      const v = verifyChain(themeId)
      console.log(`  链校验：${v.ok ? `通过（${v.count} 个事件）` : `失败 @${v.index}：${v.reason}`}`)
      console.log(`  事件总数：${getEvents(themeId).length}`)
    }
  } catch (err) {
    console.error(`  失败：${err.message}`)
    process.exitCode = 1
  }
}
