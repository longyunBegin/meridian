/**
 * 简报模板测试：占位符能被真实账本数据填满，不残留 {{}}。
 * 运行：node test/briefing.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, 'test/.tmp/briefing')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// 最小账本夹具：1 条待审批、1 条 24h 内新命题、1 个冲突、2 个主题
const fixture = {
  themes: [
    { id: 't1', name: '光互连' },
    { id: 't2', name: 'Sivers Semiconductors' },
  ],
  inbox: [
    { id: 'i1', title: '测试收件箱标题：某厂发布 1.6T 光模块', status: 'pending', createdAt: '2026-09-27T06:00:00+08:00', label: { kind: '一手数据' } },
    { id: 'i2', title: '已处理条目', status: 'done', createdAt: '2026-09-27T05:00:00+08:00' },
  ],
  nodes: [
    { id: 'n1', kind: 'lemma', themeId: 't1', title: '测试命题：硅光成本下降', confidence: 72, createdAt: '2026-09-27T06:30:00+08:00' },
    { id: 'n2', kind: 'lemma', themeId: 't2', title: '旧命题：不应出现在简报', confidence: 60, createdAt: '2026-09-20T06:30:00+08:00' },
  ],
  conflicts: [
    { id: 'c1', title: '测试冲突：两条结论打架', createdAt: '2026-09-27T07:00:00+08:00' },
  ],
}
const ledgerPath = join(TMP, 'ledger.json')
writeFileSync(ledgerPath, JSON.stringify(fixture))
const watchPath = join(TMP, 'watch.json')
writeFileSync(watchPath, JSON.stringify([
  { theme: '光互连', hits: [{ title: '命中标题', source: 'LightCounting', url: 'https://example.com/1', why: '直接相关' }] },
]))
const outPath = join(TMP, 'briefing.html')
execFileSync('node', [
  join(ROOT, 'src/main/briefing/render.mjs'),
  '--ledger', ledgerPath, '--watch', watchPath, '--date', '2026-09-27', '--out', outPath,
], { stdio: 'pipe' })
const html = readFileSync(outPath, 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}
ok('无残留占位符', !html.includes('{{'), html.match(/{{(\w+)}}/)?.[0] || '')
ok('待审批标题填入', html.includes('测试收件箱标题'))
ok('已处理条目不出现', !html.includes('已处理条目'))
ok('24h 内命题填入', html.includes('测试命题：硅光成本下降'))
ok('旧命题不出现', !html.includes('不应出现在简报'))
ok('追踪命中填入', html.includes('命中标题') && html.includes('https://example.com/1'))
ok('冲突填入', html.includes('测试冲突'))
ok('Logo SVG 内联', html.includes('<svg'))
ok('四色分区都在', ['#ff9500', '#0071e3', '#00b8b8', '#ff3b30'].every((c) => html.includes(c)))

console.log(`\n${pass} 通过, ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
