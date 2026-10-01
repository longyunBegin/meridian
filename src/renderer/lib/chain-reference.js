/** Resolve a stable event ID or sourceRef using actual ledger rows only. */
export function resolveEventReference(events, reference) {
  const raw = typeof reference === 'string' ? reference : ''
  if (!raw) return { status: 'missing', reference: '', label: '未记录来源' }

  const rows = Array.isArray(events) ? events.filter((event) => event && typeof event === 'object' && !Array.isArray(event)) : []
  const byId = new Map(rows.filter((event) => typeof event.id === 'string').map((event) => [event.id, event]))
  const exact = byId.get(raw) || null
  const sourceMatches = rows.filter((event) => event.payload?.sourceRef === raw)
  const preferredSource = sourceMatches.find((event) => ['claim.created', 'inference.created', 'evidence.appended'].includes(event.type))
    || sourceMatches[0]
    || null
  const event = exact || preferredSource
  if (!event) return { status: 'unresolved', reference: raw, label: '来源未解析' }

  const payload = event.payload || {}
  const eventSourceMatches = payload.sourceRef
    ? rows.filter((row) => row.payload?.sourceRef === payload.sourceRef)
    : []
  let subjectEvent = preferredSource || event
  if (['node.archived', 'node.restored', 'settlement.recorded'].includes(event.type)) {
    subjectEvent = eventSourceMatches.find((row) => ['claim.created', 'inference.created', 'evidence.appended'].includes(row.type))
      || eventSourceMatches[0] || preferredSource || event
  }
  const subjectPayload = subjectEvent.payload || {}
  const subjectTitle = String(subjectPayload.title || subjectPayload.coreInfo || subjectPayload.legacySource?.label
    || subjectPayload.text || payload.title || payload.coreInfo || payload.legacySource?.label || payload.text || '').trim()

  return {
    status: 'resolved',
    reference: raw,
    eventId: event.id,
    event,
    subjectEvent,
    subjectTitle,
  }
}
