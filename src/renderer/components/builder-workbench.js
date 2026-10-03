/** Merge inbox sources, model proposals, and still-pending ledger signals into one actionable queue. */
export function buildWorkbenchEntries(items = [], legacySignals = [], reviewed = new Map(), localVerdicts = new Map()) {
  const entries = []
  for (const item of items) {
    const results = item.enginePipeline?.results || []
    if (results.length) {
      results.forEach((result, index) => {
        const proposalId = result.proposalEventId || `${item.id}:${index}`
        entries.push({
          id: `proposal:${proposalId}`, kind: 'proposal', item, result,
          decision: result.reviewDecision || reviewed.get(proposalId)?.decision || null,
        })
      })
    } else entries.push({ id: `source:${item.id}`, kind: 'source', item, result: null, decision: null })
  }
  for (const signal of legacySignals) {
    const review = reviewed.get(signal.id)
    entries.push({
      id: `signal:${signal.id}`, kind: 'legacy-signal', signal,
      decision: localVerdicts.get(signal.id) || review?.decision || null,
    })
  }
  return entries
}

export function filterWorkbenchEntries(entries, mode = 'pending') {
  return entries.filter((entry) => mode === 'processed' ? Boolean(entry.decision) : !entry.decision)
}
