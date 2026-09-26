#!/usr/bin/env node
/**
 * 每日简报渲染器：把 template.html 的占位符填上账本真实数据，输出成品 HTML。
 *
 * 用法：
 *   node src/main/briefing/render.mjs [--ledger <meridian.json>] [--watch <watch.json>]
 *        [--date YYYY-MM-DD] [--out briefing.html]
 *
 * --watch 的 JSON 格式：[{ "theme": "光互连", "hits": [{ "title": "...", "source": "...", "url": "...", "why": "..." }] }]
 * 不传则追踪区块显示"今日无强相关命中"。
 *
 * 只读账本，不写任何东西。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']] : [],
  ),
)
const LEDGER = args.ledger || process.env.MERIDIAN_LEDGER || join(homedir(), '.config/脉络/meridian.json')
const DATE = args.date || new Date().toISOString().slice(0, 10)

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const FONT = `-apple-system,'SF Pro Text','PingFang SC','Helvetica Neue','Microsoft YaHei',sans-serif`
const row = (inner) =>
  `<tr><td style="padding:10px 4px;border-top:1px solid rgba(0,0,0,0.06);">${inner}</td></tr>`
const titleLine = (t) =>
  `<div style="font-family:${FONT};font-size:14px;line-height:1.55;color:#1d1d1f;">${esc(t)}</div>`
const metaLine = (m) =>
  `<div style="font-family:${FONT};font-size:12px;color:rgba(29,31,33,0.5);margin-top:4px;">${m}</div>`
const badge = (text, bg, fg) =>
  `<span style="display:inline-block;font-family:${FONT};font-size:11px;color:${fg};background:${bg};border-radius:20px;padding:2px 10px;margin-right:6px;">${esc(text)}</span>`
const emptyState = (text) =>
  row(`<div style="font-family:${FONT};font-size:13px;color:rgba(29,31,33,0.45);padding:6px 0;">${esc(text)}</div>`)
const confBar = (conf) => {
  const c = Math.max(0, Math.min(100, Number(conf) || 0))
  return `<table role="presentation" width="180" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr>` +
    `<td width="${c}%" bgcolor="#0071e3" style="height:5px;font-size:0;line-height:0;border-radius:3px;">&nbsp;</td>` +
    `<td bgcolor="#e9e9ee" style="height:5px;font-size:0;line-height:0;border-radius:3px;">&nbsp;</td>` +
    `</tr></table>`
}

const db = JSON.parse(readFileSync(LEDGER, 'utf8'))
const inbox = db.inbox || []
const nodes = db.nodes || []
const themes = db.themes || []
const conflicts = db.conflicts || []
const themeName = (id) => themes.find((t) => t.id === id)?.name || '未归属'

const dayStart = new Date(DATE + 'T00:00:00+08:00').getTime()
const inWindow = (ts) => {
  const t = new Date(ts).getTime()
  return Number.isFinite(t) && t >= dayStart - 24 * 3600 * 1000 && t < dayStart + 24 * 3600 * 1000
}

// ---- 待审批收件箱 ----
const pending = inbox.filter((i) => i.status === 'pending')
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
const pendingRows = pending.length
  ? pending.slice(0, 8).map((i) =>
      row(titleLine(i.title || '(无标题)') +
        metaLine(badge(i.label?.kind || i.sourceKind || '外部', 'rgba(255,149,0,0.14)', '#b26a00') +
          `<span>${esc((i.createdAt || '').slice(0, 10))}</span>`)),
    ).join('') +
    (pending.length > 8
      ? row(`<div style="font-family:${FONT};font-size:12px;color:rgba(29,31,33,0.5);">还有 ${pending.length - 8} 条，在 App 收件箱里逐条过</div>`)
      : '')
  : emptyState('收件箱是空的，昨天没有需要你拍板的东西')

// ---- 新增命题 ----
const fresh = nodes
  .filter((n) => n.kind === 'lemma' && inWindow(n.createdAt))
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
const newRows = fresh.length
  ? fresh.slice(0, 8).map((n) =>
      row(titleLine(n.title) +
        metaLine(badge(themeName(n.themeId).slice(0, 12), 'rgba(0,113,227,0.12)', '#0071e3') +
          `<span>置信度 ${n.confidence ?? '—'}</span>`) +
        confBar(n.confidence)),
    ).join('') +
    (fresh.length > 8
      ? row(`<div style="font-family:${FONT};font-size:12px;color:rgba(29,31,33,0.5);">还有 ${fresh.length - 8} 条，在 App 脉络页里查看</div>`)
      : '')
  : emptyState('过去 24 小时没有新命题入库')

// ---- 主题追踪 ----
let watch = []
if (args.watch && args.watch !== '1') {
  try { watch = JSON.parse(readFileSync(args.watch, 'utf8')) } catch { watch = [] }
}
const watchHits = watch.flatMap((w) => (w.hits || []).map((h) => ({ ...h, theme: w.theme })))
const watchBlocks = watchHits.length
  ? watch.map((w) =>
      row(`<div style="font-family:${FONT};font-size:13px;font-weight:700;color:#1d1d1f;margin-bottom:6px;">${esc(w.theme)}</div>` +
        (w.hits || []).map((h) =>
          `<div style="font-family:${FONT};font-size:13px;line-height:1.6;color:#1d1d1f;margin:6px 0 2px 0;">· ${h.url ? `<a href="${esc(h.url)}" style="color:#0071e3;text-decoration:none;">${esc(h.title)}</a>` : esc(h.title)}</div>` +
          (h.why ? `<div style="font-family:${FONT};font-size:12px;color:rgba(29,31,33,0.5);margin:0 0 6px 14px;">${esc(h.why)}</div>` : '') +
          (h.source ? metaLine(`<span style="margin-left:14px;">${esc(h.source)}</span>`) : ''),
        ).join('')),
    ).join('')
  : emptyState('今日两次追踪都没有强相关命中，不打扰')

// ---- 冲突 ----
const freshConflicts = conflicts.filter((c) => inWindow(c.createdAt || c.updatedAt))
const conflictBlock = freshConflicts.length
  ? freshConflicts.slice(0, 5).map((c) =>
      row(titleLine(c.title || c.summary || '(冲突)') +
        metaLine(`${badge('待裁决', 'rgba(255,59,48,0.12)', '#d70015')}<span>${esc((c.createdAt || '').slice(0, 10))}</span>`)),
    ).join('')
  : row(`<table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
      `<td width="36" valign="top" style="font-size:20px;">✓</td>` +
      `<td><div style="font-family:${FONT};font-size:14px;color:#1d1d1f;">今日无新增冲突</div>` +
      `<div style="font-family:${FONT};font-size:12px;color:rgba(29,31,33,0.5);margin-top:4px;">现有结论自洽，不需要你介入</div></td>` +
      `</tr></table>`)

// ---- 导读 ----
const bits = []
if (pending.length) bits.push(`${pending.length} 条待审批`)
if (fresh.length) bits.push(`${fresh.length} 条新命题入库`)
if (watchHits.length) bits.push(`${watchHits.length} 条追踪命中`)
if (freshConflicts.length) bits.push(`${freshConflicts.length} 个新冲突`)
const lede = bits.length
  ? `你好，${bits.join('、')}。下面是明细，置信度与入库都以你的审批为准。`
  : '你好，过去 24 小时风平浪静：没有待审批事项，没有新命题，也没有冲突。追踪任务也没有捞到强相关信息。'

const tpl = readFileSync(join(HERE, 'template.html'), 'utf8')
const out = tpl
  .replaceAll('{{date_str}}', esc(DATE))
  .replaceAll('{{theme_count}}', String(themes.length))
  .replaceAll('{{node_count}}', String(nodes.length))
  .replaceAll('{{lede}}', esc(lede))
  .replaceAll('{{stat_pending}}', String(pending.length))
  .replaceAll('{{stat_new}}', String(fresh.length))
  .replaceAll('{{stat_watch}}', String(watchHits.length))
  .replaceAll('{{stat_conflict}}', String(freshConflicts.length))
  .replaceAll('{{conflict_color}}', freshConflicts.length ? '#ff3b30' : 'rgba(29,31,33,0.3)')
  .replaceAll('{{conflict_bar}}', freshConflicts.length ? '#ff3b30' : '#34c759')
  .replaceAll('{{conflict_sub}}', freshConflicts.length ? '需要你看一眼' : '一切正常')
  .replaceAll('{{pending_rows}}', pendingRows)
  .replaceAll('{{new_rows}}', newRows)
  .replaceAll('{{watch_blocks}}', watchBlocks)
  .replaceAll('{{conflict_block}}', conflictBlock)

if (out.includes('{{')) {
  console.error('未替换的占位符:', [...out.matchAll(/{{(\w+)}}/g)].map((m) => m[1]))
  process.exit(1)
}
if (args.out && args.out !== '1') writeFileSync(args.out, out)
else process.stdout.write(out)
console.error(`render ok: pending=${pending.length} new=${fresh.length} watch=${watchHits.length} conflicts=${freshConflicts.length}`)
