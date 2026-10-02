/**
 * 置信度更新公式测试（红区已批准）。
 * 运行：node test/engine-confidence.test.mjs
 */
import { updateConfidence, estimateStrength, CONFIDENCE_ALPHA, CONFIDENCE_BETA } from '../src/main/engine-confidence.js'

let passed = 0
let failed = 0
const ok = (name, condition, extra = '') => {
  condition ? passed++ : failed++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${extra ? `  ${extra}` : ''}`)
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

ok('参数 α<β', CONFIDENCE_ALPHA < CONFIDENCE_BETA, `α=${CONFIDENCE_ALPHA} β=${CONFIDENCE_BETA}`)

/* 支持：new = old + (1-old) × strength × α */
ok('支持更新', approx(updateConfidence(0.5, 1.0, 'supports'), 0.5 + 0.5 * 1.0 * 0.3))
ok('支持有上界', updateConfidence(0.9, 1.0, 'supports') <= 1.0)
ok('高置信度提升小（边际递减）',
  (updateConfidence(0.9, 1.0, 'supports') - 0.9) < (updateConfidence(0.5, 1.0, 'supports') - 0.5))

/* 反驳：new = old - old × strength × β */
ok('反驳更新', approx(updateConfidence(0.5, 1.0, 'contradicts'), 0.5 - 0.5 * 1.0 * 0.5))
ok('反驳有下界', updateConfidence(0.1, 1.0, 'contradicts') >= 0.0)
ok('反驳比支持有力', 
  (0.5 - updateConfidence(0.5, 1.0, 'contradicts')) > (updateConfidence(0.5, 1.0, 'supports') - 0.5))

/* 边界 */
ok('null 返回 null', updateConfidence(null, 0.5, 'supports') === null)
ok('非法关系不更新', updateConfidence(0.5, 0.8, 'derives') === 0.5)
ok('强度钳制', updateConfidence(0.5, 2.0, 'supports') === updateConfidence(0.5, 1.0, 'supports'))

/* 强度估算 */
ok('硬事实强度高', estimateStrength({ isHardFact: true }) > estimateStrength({ isHardFact: false }))
ok('有 URL 加成', estimateStrength({ isHardFact: false, hasUrl: true }) > estimateStrength({ isHardFact: false }))

console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed ? 1 : 0)
