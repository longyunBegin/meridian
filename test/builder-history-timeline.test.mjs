import assert from 'node:assert/strict'
import { builderHistoryTimelineModel, describeBuilderHistoryPoint } from '../src/renderer/components/builder-history-timeline.js'

const model = builderHistoryTimelineModel([
  { seq: 3, id: 'e3', type: 'evidence.appended', at: '2026-04-18T11:00:00Z' },
  { seq: 2, id: 'e2', type: 'node.created' },
  { seq: 1, id: 'e1', type: 'theme.created', at: '2024-02-03T09:30:00Z' },
])
assert.deepEqual(model.points.map((point) => point.seq), [1, 2, 3], 'timeline is ordered by immutable ledger sequence')
assert.equal(model.hasDates, true, 'real event timestamps are recognized')
assert.match(describeBuilderHistoryPoint(model.points[0]), /2024-02-03.*第 1 条事件/)
assert.equal(describeBuilderHistoryPoint(model.points[1]), '日期未记录 · 第 2 条事件', 'missing timestamps are never invented')

const undated = builderHistoryTimelineModel([{ seq: 1, type: 'theme.created' }, { seq: 2, type: 'node.created' }])
assert.equal(undated.hasDates, false)
assert.equal(describeBuilderHistoryPoint(undated.points[1]), '日期未记录 · 第 2 条事件')
assert.equal(describeBuilderHistoryPoint(null), '暂无可回放的已校验事件；不会从节点数量推断日期。')
console.log('Builder history timeline model: 7/7 passed')
