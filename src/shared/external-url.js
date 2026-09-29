/** Return a canonical HTTP(S) URL or null; opening itself is delegated to the desktop host. */
export function normalizeExternalUrl(value) {
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed.toString()
  } catch {
    return null
  }
}
