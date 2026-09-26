/**
 * 反向同步 outbox（Mac 端，Tailscale 反向同步 Phase 3-1）。
 *
 * 模型：Mac App 保持本地即时执行（UI 零改动），用户发起的变更类操作在
 * 成功后追加一条记录到 sync-outbox.jsonl（append-only）。VM 上的同步桥
 * 经 Tailscale 轮询拉取这些记录，用同一套 IPC handler 在 VM 账本上重放，
 * 然后 ack。outbox 为空时 VM 才会把快照推回 Mac。
 *
 * 白名单原则（只收录以下 channel，绝不全量录制）：
 *  - 用户发起、确定性、可重放幂等；
 *  - 不创建/修改/删除 lemmas（用户公理）；
 *  - 不跑 LLM 流水线（重放会产生不同结果、浪费调用）；
 *  - 不碰 settings/密钥（机器绑定，同步会冲掉本机密钥）。
 *
 * 明确排除（及原因）：
 *  - db:addNode/updateNode/removeNode/restoreNode/spawn/purgeDead/repropagate
 *    → lemma 增删改，用户公理红线。
 *  - theme:add/remove/restore/regenerate/setupNew/scaffoldExisting
 *    → 主题生命周期；scaffold 系会自动建 lemma，未经授权不得重放。
 *  - inbox:capture/import/extract → LLM 流水线，非确定性，重放浪费调用且发散。
 *  - inbox:undoAutoImport → 内部调 removeNode/updateNode，且 addInboxItem 重放会造重复条目。
 *  - reading:add/push/assign/evidence → ingestReadingCore / 哈希链是红区。
 *  - settings:set → apiKey 等与机器绑定，同步到 VM 会冲掉 VM 的可用密钥。
 *  - raw:clear/prune、io:import → 破坏性 / importAll 红区。
 *  - agent:* → agent 服务安全边界红区。
 */

import { appendFileSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { uid } from './store.js'

/** 收录进 outbox 的 channel 白名单。 */
export const OUTBOX_CHANNELS = new Set([
  'inbox:resolve', // 收件箱裁决 accept/reject：幂等（非 pending 直接返回原条目）
  'inbox:prune', // 按天清理：集合删除，重放收敛
  'inbox:clear', // 清空收件箱：filter 删除，重放幂等
  'inbox:clearUnextracted', // 清未抽取：同上
  'db:resolveConflict', // 冲突裁决：resolved 标志位覆写，幂等
  'db:settle', // 命题结算：settlement 覆写，不碰 confidence
  'theme:rename', // 主题改名：覆写，幂等
  'theme:update', // 主题更新：patch 覆写
])

const OUTBOX_NAME = 'sync-outbox.jsonl'

function defaultDir() {
  return globalThis.__electron.app.getPath('userData')
}

export const outboxFile = (dir = defaultDir()) => join(dir, OUTBOX_NAME)

/**
 * 记录一条 outbox。只在 handler 成功返回后调用；记录失败绝不影响用户操作本身。
 * @returns entry id，失败返回 null
 */
export function recordOutbox(channel, args, dir = defaultDir()) {
  try {
    const entry = { id: uid(), ts: Date.now(), channel, args }
    appendFileSync(outboxFile(dir), JSON.stringify(entry) + '\n')
    return entry.id
  } catch (err) {
    console.error('[sync-outbox] 记录失败（已跳过，不影响本次操作）:', err?.message || err)
    return null
  }
}

/** 读出全部待同步条目。坏行跳过并告警，不中断。 */
export function readOutbox(dir = defaultDir()) {
  const file = outboxFile(dir)
  if (!existsSync(file)) return []
  const entries = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t)
      if (e && typeof e.id === 'string' && typeof e.channel === 'string') entries.push(e)
    } catch (err) {
      console.error('[sync-outbox] 坏行跳过:', err?.message || err)
    }
  }
  return entries
}

export function outboxCount(dir = defaultDir()) {
  return readOutbox(dir).length
}

/**
 * 确认已同步的条目（原子重写）。@returns 移除条数
 */
export function ackOutbox(ids, dir = defaultDir()) {
  const idSet = new Set(ids)
  const file = outboxFile(dir)
  const before = readOutbox(dir)
  const kept = before.filter((e) => !idSet.has(e.id))
  const tmp = file + '.tmp'
  writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''))
  renameSync(tmp, file)
  return before.length - kept.length
}

/**
 * 把 ipcMain 包装成 outbox 感知版：白名单 channel 的 handler 成功后自动记录。
 * 非白名单 channel 原样透传。service（shim）与测试默认不启用。
 */
export function withOutbox(rawIpcMain) {
  return {
    handle: (channel, fn) => {
      if (!OUTBOX_CHANNELS.has(channel)) return rawIpcMain.handle(channel, fn)
      return rawIpcMain.handle(channel, async (event, ...args) => {
        const result = await fn(event, ...args)
        recordOutbox(channel, args)
        return result
      })
    },
  }
}
