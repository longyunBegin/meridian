import { ingestReadingCore } from './store.js'
import { validateReading, validDate } from './reading-store.js'
import { labelSource } from './labeler.js'

const MAX_BYTES = 1024 * 1024
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const ENVELOPE_FIELDS = new Set(['schema', 'at', 'themeHint', 'readings'])
const READING_FIELDS = new Set(['indicator', 'value', 'unit', 'period', 'basis', 'tier', 'source', 'raw', 'metric', 'indicatorId', 'nodeId', 'channelId', 'dedupeKey', 'status', 'trust', 'hash', 'prevHash', 'supersedes', 'rawId', 'sourceId', 'id', 'at'])
const SOURCE_FIELDS = new Set(['kind', 'label', 'url', 'platform', 'accn', 'filed', 'form', 'start', 'end', 'frame'])
const SECRET_FIELDS = /^(?:api[-_]?key|authorization|password|secret|token|credentials|settings)$/i

function checkSecrets(value) {
  if (!object(value) && !Array.isArray(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELDS.test(key)) throw new Error('契约禁止携带密钥或凭据')
    if (item && typeof item === 'object') checkSecrets(item)
  }
}

/** 纯验证，无网络、无写盘。返回规范 envelope 及逐项拒绝；供文件/HTTP 共用。 */
export function validateEnvelope(input, { trusted = false } = {}) {
  try {
    let serialized
    if (Buffer.isBuffer(input)) {
      if (input.length > MAX_BYTES) throw new Error('契约超过 1MB')
      serialized = new TextDecoder('utf-8', { fatal: true }).decode(input)
    } else if (typeof input === 'string') serialized = input
    else serialized = JSON.stringify(input)
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new Error('契约超过 1MB 或无法序列化')
    const envelope = JSON.parse(serialized)
    if (!object(envelope) || envelope.schema !== 'meridian.reading.v1') throw new Error('schema 必须为 meridian.reading.v1')
    if (Object.keys(envelope).some((k) => !ENVELOPE_FIELDS.has(k))) throw new Error('契约包含未定义字段')
    if (!Array.isArray(envelope.readings) || !envelope.readings.length || envelope.readings.length > 1000) throw new Error('readings 必须是 1 到 1000 条的数组')
    if (envelope.at != null && !validDate(envelope.at)) throw new Error('at 日期无效')
    if (envelope.themeHint != null && (typeof envelope.themeHint !== 'string' || envelope.themeHint.length > 512)) throw new Error('themeHint 无效')
    checkSecrets(envelope)
    const rejected = []
    const items = []
    envelope.readings.forEach((r, index) => {
      try {
        if (!object(r) || Object.keys(r).some((k) => !READING_FIELDS.has(k))) throw new Error('读数包含未定义字段')
        if (!trusted && (typeof r.indicator !== 'string' || !r.indicator.trim())) throw new Error('indicator 人话名称不能为空')
        if (!object(r.period) || Object.keys(r.period).some((k) => !['start', 'end'].includes(k)) || !r.period.start || !r.period.end) throw new Error('period 必须包含 start/end')
        if (typeof r.unit !== 'string' || !r.unit.trim()) throw new Error('unit 不能为空')
        if (!object(r.source) || !r.source.url || typeof r.source.label !== 'string' || !r.source.label.trim() || Object.keys(r.source).some((k) => !SOURCE_FIELDS.has(k))) throw new Error('source 必须包含名称和 http/https url 且仅有约定字段')
        // 不信内部标识/状态/签名，不透传即使形式上允许兼容字段。
        const clean = validateReading(r)
        items.push({ index, reading: { ...clean, themeHint: envelope.themeHint, ...(trusted ? { metric: r.metric, indicatorId: r.indicatorId, nodeId: r.nodeId } : { metric: '' }) } })
      } catch (error) { rejected.push({ index, reason: error.message }) }
    })
    return { ok: true, envelope: { schema: envelope.schema, at: envelope.at, themeHint: envelope.themeHint }, items, rejected, total: envelope.readings.length }
  } catch (error) {
    return { ok: false, error: error.message, items: [], rejected: [{ index: -1, reason: error.message }], total: 0 }
  }
}

/** trusted 仅给受控的主进程内置调用；外部 adapter 绝不能从请求中取这个参数。 */
export async function ingestReadings(envelope, { trusted = false, channelId = null, onProgress } = {}) {
  const checked = validateEnvelope(envelope, { trusted })
  const result = { ok: checked.ok, accepted: 0, duplicates: 0, rejected: [...checked.rejected], total: checked.total }
  if (!checked.ok) return result
  let processed = checked.rejected.length
  for (const { index, reading } of checked.items) {
    const label = await labelSource({ labeler: 'table' }, reading.raw || reading.source.label, reading.source)
    const outcome = ingestReadingCore({ ...reading, source: { ...reading.source, kind: label.kind } }, { trusted, channelId: trusted ? channelId : null })
    if (outcome.added) result.accepted++
    else if (outcome.error) result.rejected.push({ index, reason: outcome.error })
    else result.duplicates++
    processed++
    if (processed % 25 === 0) {
      if (typeof onProgress === 'function') {
        try { await onProgress({ ...result, rejected: [...result.rejected], processed }) } catch { /* UI 回调不能中断已提交事务 */ }
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  result.rejected.sort((a, b) => a.index - b.index)
  result.ok = result.rejected.length === 0
  if (typeof onProgress === 'function') {
    try { await onProgress({ ...result, rejected: [...result.rejected], processed }) } catch { /* 同上 */ }
  }
  return result
}
