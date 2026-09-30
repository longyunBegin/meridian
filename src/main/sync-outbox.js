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
import { dataDirectory } from './runtime-services.js'

/** 收录进 outbox 的 channel 白名单。 */
export const OUTBOX_CHANNELS = new Set([
  'inbox:resolve', // 收件箱裁决 accept/reject：幂等（非 pending 直接返回原条目）
  'inbox:prune', // 按天清理：集合删除，重放收敛
  'inbox:deleteIds', // 按 id 精确删除（clear/clearUnextracted 的同步形态）：源头在录制前已算好
                     // deletedIds，回放不重算 extracted/pending 谓词（谓词依赖按设备各自持有的
                     // extracted 状态，重算会导致两端删出不同集合）。幂等：不存在的 id 跳过。
  'inbox:clear', // 旧版录制的 filter 删除：保留回放兼容（新版录制已改走 inbox:deleteIds）
  'inbox:clearUnextracted', // 同上
  'inbox:extract', // 批量抽取：幂等（已抽取条目跳过）；回放时在 VM 侧重跑真实流水线
  'inbox:import', // 批量入库：建节点非幂等！桥回放前先查 VM 侧条目状态，过滤掉已接受的（见 service/sync-bridge.mjs）
  'inbox:setTheme', // 收件箱条目换主题：覆写 extractedThemeId，幂等
  'db:resolveConflict', // 冲突裁决：resolved 标志位覆写，幂等
  'db:settle', // 命题结算：settlement 覆写，不碰 confidence
  'theme:rename', // 主题改名：覆写，幂等
  'theme:update', // 主题更新：patch 覆写
])

/**
 * VM→Mac 方向的 op 白名单（双向 op log 的另一半）。
 * 与 OUTBOX_CHANNELS 互补：这些 channel 只由 VM 侧产生（capture 结果），
 * Mac 侧 /sync/ops 按 channel 原样调用本地 handler 应用。
 * 语义要求：全部 insert-if-absent / 幂等追加，绝不修改既有节点的 confidence。
 */
export const VM_OP_CHANNELS = new Set([
  'inbox:upsertItem', // 收件箱条目按 id 插入，已存在则跳过（绝不覆盖用户裁决状态）
  'db:upsertNode', // 节点快照按 id 插入，已存在则跳过
  'db:addSource', // 给已存在节点追加来源（normalizeSources 去重，收敛）
  'raw:upsert', // 原文记录按 id 插入（content-hash 去重天然收敛）
])

const OUTBOX_NAME = 'sync-outbox.jsonl'
const SEQ_NAME = 'sync-outbox.seq'

function defaultDir() {
  return dataDirectory()
}

export const outboxFile = (dir = defaultDir()) => join(dir, OUTBOX_NAME)

/** 读 seq 计数器（不存在视为 0）。 */
function readSeq(dir) {
  const f = join(dir, SEQ_NAME)
  if (!existsSync(f)) return 0
  const n = Number(readFileSync(f, 'utf8').trim())
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

/** 原子写 seq 计数器。 */
function writeSeq(dir, n) {
  const f = join(dir, SEQ_NAME)
  const tmp = f + '.tmp'
  writeFileSync(tmp, String(n) + '\n')
  renameSync(tmp, f)
}

/**
 * 记录一条 outbox。只在领域命令成功返回后调用；记录失败绝不影响用户操作本身。
 * 每条 entry 带单调递增 seq，供双向同步做游标（cursor）续传。
 * @returns entry id，失败返回 null
 */
export function recordOutbox(channel, args, dir = defaultDir()) {
  try {
    migrateSeqIfNeeded(dir)
    const seq = readSeq(dir) + 1
    const entry = { id: uid(), ts: Date.now(), seq, channel, args }
    appendFileSync(outboxFile(dir), JSON.stringify(entry) + '\n')
    writeSeq(dir, seq)
    return entry.id
  } catch (err) {
    console.error('[sync-outbox] 记录失败（已跳过，不影响本次操作）:', err?.message || err)
    return null
  }
}

/**
 * 一次性迁移：给历史无 seq 条目按文件顺序补 seq 1..N，并初始化计数器。
 * outbox 是 append-only，ack 只删整行不改序，位置即顺序，迁移后稳定。
 */
function migrateSeqIfNeeded(dir) {
  if (existsSync(join(dir, SEQ_NAME))) return
  const file = outboxFile(dir)
  const entries = []
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t)
        if (e && typeof e.id === 'string' && typeof e.channel === 'string') entries.push(e)
      } catch { /* 坏行在 readOutbox 里处理，这里只计数 */ }
    }
  }
  let maxSeq = 0
  entries.forEach((e, i) => {
    if (typeof e.seq !== 'number' || e.seq <= 0) e.seq = i + 1
    if (e.seq > maxSeq) maxSeq = e.seq
  })
  if (existsSync(file)) {
    const tmp = file + '.tmp'
    writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
    renameSync(tmp, file)
  }
  writeSeq(dir, maxSeq)
}

/** 读出全部待同步条目。坏行跳过并告警，不中断。 */
export function readOutbox(dir = defaultDir(), since = 0) {
  migrateSeqIfNeeded(dir)
  const file = outboxFile(dir)
  if (!existsSync(file)) return []
  const entries = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t)
      if (e && typeof e.id === 'string' && typeof e.channel === 'string' && (e.seq || 0) > since) entries.push(e)
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
 * 按游标确认：丢弃 seq <= cursor 的条目（双向 op log 的标准 ack）。
 * @returns 移除条数
 */
export function ackOutboxCursor(cursor, dir = defaultDir()) {
  const c = Number(cursor) || 0
  const file = outboxFile(dir)
  const before = readOutbox(dir)
  const kept = before.filter((e) => (e.seq || 0) > c)
  const tmp = file + '.tmp'
  writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''))
  renameSync(tmp, file)
  return before.length - kept.length
}

