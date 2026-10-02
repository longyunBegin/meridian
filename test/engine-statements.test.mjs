/**
 * 原子陈述数据模型测试。
 * 运行：node test/engine-statements.test.mjs
 */
import {
  STATEMENT_TYPES, STATEMENT_TYPE_LABEL,
  ATTRIBUTION_RELS, ATTRIBUTION_REL_LABEL,
  validateStatement, createStatement, createMatch, createAttribution,
} from '../src/main/engine-statements.js'

let passed = 0
let failed = 0
const ok = (name, condition, extra = '') => {
  condition ? passed++ : failed++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${extra ? `  ${extra}` : ''}`)
}

/* 四种类型 */
ok('四种陈述类型', STATEMENT_TYPES.join(',') === 'hard,soft,relational,meta')
ok('类型标签', STATEMENT_TYPE_LABEL.hard === '硬事实' && STATEMENT_TYPE_LABEL.meta === '元陈述')

/* 五种关系 */
ok('五种归因关系', ATTRIBUTION_RELS.join(',') === 'supports,contradicts,derives,supersedes,related')
ok('关系标签', ATTRIBUTION_REL_LABEL.supersedes === '取代' && ATTRIBUTION_REL_LABEL.related === '相关')

/* 验证 */
ok('空对象无效', validateStatement(null).length > 0)
ok('缺少主体', validateStatement({ attribute: 'a', value: 'v', timeWindow: 't', type: 'hard' }).includes('缺少主体'))
ok('类型错误', validateStatement({ subject: 's', attribute: 'a', value: 'v', timeWindow: 't', type: 'bad' }).length > 0)
ok('完整有效', validateStatement({ subject: 's', attribute: 'a', value: 'v', timeWindow: 't', type: 'hard' }).length === 0)

/* 创建 */
const stmt = createStatement({
  subject: '光子业务', attribute: 'Q2营收占比', value: '28%', timeWindow: '2026Q2',
  type: 'hard', sourceText: '占比升至28%', inboxId: 'inbox:123',
})
ok('创建陈述', stmt.id.startsWith('stmt:') && stmt.subject === '光子业务' && stmt.type === 'hard')
ok('陈述带来源', stmt.inboxId === 'inbox:123' && stmt.sourceText === '占比升至28%')

let threw = false
try {
  createStatement({ subject: '', attribute: 'a', value: 'v', timeWindow: 't', type: 'hard' })
} catch { threw = true }
ok('无效陈述抛错', threw)

/* 匹配 */
const match = createMatch('stmt:1', 'prop:1', { semantic: true, subject: true, temporal: true, score: 0.85 })
ok('三维全过才有资格', match.eligible === true && match.score === 0.85)
const badMatch = createMatch('stmt:1', 'prop:1', { semantic: true, subject: false, temporal: true, score: 0.5 })
ok('主体不过无资格', badMatch.eligible === false)

/* 归因 */
const attr = createAttribution('stmt:1', 'prop:1', { rel: 'supports', strength: 0.62, reason: '占比上升支持终点' })
ok('创建归因', attr.rel === 'supports' && attr.strength === 0.62)
threw = false
try {
  createAttribution('stmt:1', 'prop:1', { rel: 'bad', strength: 0.5 })
} catch { threw = true }
ok('非法关系抛错', threw)

console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed ? 1 : 0)
