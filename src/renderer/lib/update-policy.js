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

/** Presentation-only state model shared by the updater UI and synthetic tests. */
export function updatePresentation(state, { retryInstall = false } = {}) {
  const common = { canClose: true, primaryAction: null, primaryLabel: '', primaryDisabled: false }
  if (state === 'available') return {
    ...common, title: '有新版本', description: '查看更新内容后，可选择下载并稍后决定是否安装。',
    primaryAction: 'download', primaryLabel: '下载更新',
  }
  if (state === 'downloading') return {
    ...common, canClose: false, title: '正在下载更新', description: '下载完成后仍需你确认安装并重新启动。',
    primaryAction: null, primaryLabel: '正在下载…', primaryDisabled: true,
  }
  if (state === 'ready') return {
    ...common, title: '更新已准备好', description: '更新已下载。选择重新启动以安装更新并重新打开 Meridian。',
    primaryAction: 'install', primaryLabel: '重新启动以更新',
  }
  if (state === 'installing') return {
    ...common, canClose: false, title: '正在安装更新', description: '安装完成后应用会按既有流程重新启动。',
    primaryAction: null, primaryLabel: '正在安装…', primaryDisabled: true,
  }
  if (state === 'error') return {
    ...common, title: '更新未完成', description: retryInstall ? '安装未完成，可重试；关闭提示不会安装更新。' : '下载失败，可重试或稍后从设置中重新检查。',
    primaryAction: retryInstall ? 'install' : 'download', primaryLabel: retryInstall ? '重试安装' : '重试下载',
  }
  if (state === 'cancelled') return {
    ...common, title: '稍后再更新', description: '更新没有安装或重启；你可以稍后从设置中重新检查。',
  }
  if (state === 'installed') return {
    ...common, canClose: false, title: '正在重新启动', description: '更新已安装，正在重新打开 Meridian。',
    primaryAction: null, primaryLabel: '正在重新启动…', primaryDisabled: true,
  }
  if (state === 'restart-error') return {
    ...common, title: '更新已安装', description: '应用未能自动重新启动。请关闭此提示后手动重新打开 Meridian。',
  }
  return { ...common, title: '软件更新', description: '更新状态不可用。' }
}

/** True only for the explicit action matching the current, already-confirmed phase. */
export function canPerformUpdateAction(state, action, { retryInstall = false } = {}) {
  if (state === 'available') return action === 'download'
  if (state === 'ready') return action === 'install'
  if (state === 'error') return action === (retryInstall ? 'install' : 'download')
  return false
}

/** Downloads and installation are not cancellable through the Tauri updater API; never close its live resource mid-operation. */
export function canCloseUpdate(state) {
  return !['downloading', 'installing', 'installed'].includes(state)
}
