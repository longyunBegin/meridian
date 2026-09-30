export const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Return true only when an automatic check is due. Invalid/missing timestamps allow a first check. */
export function shouldAutoCheck(lastAttemptValue, now = Date.now()) {
  if (lastAttemptValue == null || String(lastAttemptValue).trim() === '') return true
  const lastAttempt = Number(lastAttemptValue)
  if (!Number.isFinite(lastAttempt) || lastAttempt <= 0) return true
  return now - lastAttempt >= AUTO_UPDATE_CHECK_INTERVAL_MS
}

export function updateProgress(downloadedBytes, totalBytes) {
  const downloaded = Math.max(0, Number(downloadedBytes) || 0)
  const total = Number(totalBytes)
  if (!Number.isFinite(total) || total <= 0) return { downloaded, total: null, percent: null }
  return {
    downloaded,
    total,
    percent: Math.max(0, Math.min(100, Math.floor((downloaded / total) * 100))),
  }
}
