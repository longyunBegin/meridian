import { h, icon, clear, toast } from '../lib/dom.js'
import { state, refresh } from '../app.js'
import { confColorContinuous } from './shared.js'

const m = window.meridian

/** 图形化展示打标结果的色板 */
const KIND_COLORS = {
  '财报 / 公告': 'var(--green)',
  '一手数据': 'var(--accent)',
  '券商研报': 'var(--purple)',
  '独立媒体': 'var(--teal)',
  '自媒体': 'var(--orange)',
  '群聊转发': 'var(--orange)',
  '道听途说': 'var(--red)',
}
const kindColor = (k) => KIND_COLORS[k] || 'var(--text-3)'

let activeFeedId = null
let feedItems = []
let loading = false
let picked = new Set()
let renderSeq = 0

export async function renderFeeds(mid) {
  const seq = ++renderSeq
  clear(mid)
  const feeds = await m.feeds()
  if (seq !== renderSeq) return

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '数据源'),
      h('p', {}, '从外部 RSS / API 拉取数据，自动 JEV 打标，图形化展示后勾选入库。'),
    ),
    h('div', { class: 'feeds-layout' },
      h('div', { class: 'feeds-side' },
        h('div', { class: 'card' },
          h('div', { class: 'card-h' }, h('h2', {}, '数据源'), h('span', { class: 'spacer' }), h('em', {}, `${feeds.length} 个`)),
          h('div', { class: 'feeds-list' },
            ...feeds.map((f) => h('button', {
              class: 'feed-item',
              'aria-selected': activeFeedId === f.id ? 'true' : 'false',
              onclick: () => { activeFeedId = f.id; feedItems = []; picked.clear(); renderFeeds(mid) },
            },
              h('span', { class: 'feed-dot', style: { background: kindColor(f.kind) } }),
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
              h('span', { class: 'feed-count' }, f.lastCount != null ? String(f.lastCount) : '—'),
            )),
            feeds.length === 0 ? h('div', { style: { padding: '12px 0', fontSize: '12px', color: 'var(--text-3)' } }, '还没有数据源，下面添加一个') : null,
          ),
          h('div', { class: 'feed-add' },
            h('input', {
              class: 'txt feed-url-input', placeholder: 'RSS URL',
              id: 'feed-url-input',
            }),
            h('input', {
              class: 'txt feed-name-input', placeholder: '名称', id: 'feed-name-input',
            }),
            h('button', {
              class: 'btn btn-primary', style: { height: '26px' },
              onclick: async () => {
                const urlEl = document.getElementById('feed-url-input')
                const nameEl = document.getElementById('feed-name-input')
                if (!urlEl) return
                const url = urlEl.value.trim()
                const name = nameEl?.value.trim() || ''
                if (!url) return
                await m.feedAdd({ url, name: name || url, kind: 'rss', themeId: state.themeId, interval: 60 })
                renderFeeds(mid)
              },
            }, icon('plus', 13), '添加'),
          ),
        ),
      ),
      h('div', { class: 'feeds-main' },
        activeFeedId ? renderFeedDetail(feeds.find((f) => f.id === activeFeedId), mid) : h('div', { class: 'feeds-empty' },
          h('div', { style: { fontSize: '15px', fontWeight: '600', color: 'var(--text-2)', marginBottom: '6px' } }, '选择一个数据源'),
          h('div', { style: { fontSize: '12px', color: 'var(--text-3)' } }, '或添加新的 RSS / API 数据源，拉取后自动打标'),
        ),
      ),
    ),
  ))
}

function renderFeedDetail(feed, mid) {
  if (!feed) return h('div', {})

  return h('div', { class: 'feed-detail' },
    h('div', { class: 'feed-detail-head' },
      h('div', {},
        h('div', { style: { fontSize: '15px', fontWeight: '600' } }, feed.name),
        h('div', { style: { fontSize: '11px', color: 'var(--text-3)', marginTop: '2px' } },
          `${feed.url} · 间隔 ${feed.interval} 分钟 · 最后拉取 ${feed.lastFetch || '从未'}`),
      ),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', {
          class: 'btn btn-primary', style: { height: '28px' },
          onclick: async () => {
            loading = true
            renderFeeds(mid)
            try {
              const r = await m.feedFetchAndLabel(feed.id)
              if (r.ok) { feedItems = r.items; picked = new Set(r.items.map((_, i) => i)) }
            } catch { feedItems = [] }
            loading = false
            renderFeeds(mid)
          },
        }, icon('lattice', 13), loading ? '拉取中…' : '拉取并打标'),
        h('button', {
          class: 'btn', style: { height: '28px', color: 'var(--red)' },
          onclick: async () => { await m.feedRemove(feed.id); activeFeedId = null; feedItems = []; renderFeeds(mid) },
        }, icon('trash', 13), '删除'),
      ),
    ),
    loading ? h('div', { class: 'feeds-loading' }, h('span', { class: 'hud-dot' }), '正在拉取并打标…') : null,
    !loading && feedItems.length > 0 ? h('div', { class: 'feed-items' },
      // 统计面板
      h('div', { class: 'feed-stats' },
        ...renderStats(feedItems),
      ),
      // 条目列表
      ...feedItems.map((item, i) => renderFeedItem(item, i, mid)),
      // 批量入库
      h('div', { class: 'feed-import-bar' },
        h('span', { style: { fontSize: '12px', color: 'var(--text-3)' } }, `已选 ${picked.size} / ${feedItems.length} 条`),
        h('span', { style: { flex: 1 } }),
        h('button', {
          class: 'btn btn-primary', style: { height: '28px' },
          onclick: async () => {
            const chosen = [...picked].sort((a, b) => a - b).map((i) => feedItems[i])
            if (!state.themeId) { toast('先选择一个主题', 'var(--red)'); return }
            await m.feedImport(feed.id, state.themeId, chosen)
            feedItems = []
            picked.clear()
            await refresh()
            renderFeeds(mid)
          },
        }, icon('plus', 13), `入库到 ${state.themes.find((t) => t.id === state.themeId)?.name || '当前主题'}`),
      ),
    ) : null,
    !loading && feedItems.length === 0 ? h('div', { class: 'feeds-empty' },
      h('div', { style: { fontSize: '13px', color: 'var(--text-3)' } }, '点击「拉取并打标」获取数据'),
    ) : null,
  )
}

function renderFeedItem(item, i, mid) {
  const label = item.label || {}
  const on = picked.has(i)
  const color = kindColor(label.kind)

  return h('div', { class: 'feed-card', dataset: { on: String(on) } },
    h('button', {
      class: 'feed-card-ck',
      onclick: () => { on ? picked.delete(i) : picked.add(i); renderFeeds(mid) },
    }, h('span', { class: 'ck', dataset: { on: String(on) } })),
    h('div', { class: 'feed-card-body' },
      h('div', { class: 'feed-card-title' }, item.title),
      h('div', { class: 'feed-card-meta' },
        h('span', { class: 'feed-badge', style: { color, background: `${color}1a` } }, label.kind || '未标'),
        h('span', { class: 'feed-quality' },
          h('span', { class: 'bar', style: { width: '40px' } },
            h('i', { style: { width: `${(label.quality || 0) * 100}%`, background: color } })),
          h('span', { style: { fontSize: '10px', color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' } }, label.quality?.toFixed(2) || '—'),
        ),
        item.dup ? h('span', { class: 'feed-dup' }, `重复 ${item.dup.score.toFixed(2)}`) : h('span', { class: 'feed-new' }, '新'),
        label.via === 'jev' ? h('span', { class: 'feed-via' }, 'Jev') : h('span', { class: 'feed-via' }, '查表'),
      ),
      item.description ? h('div', { class: 'feed-card-desc' }, item.description.slice(0, 120)) : null,
    ),
  )
}

function renderStats(items) {
  const byKind = new Map()
  for (const it of items) {
    const k = it.label?.kind || '未标'
    byKind.set(k, (byKind.get(k) || 0) + 1)
  }
  const sorted = [...byKind.entries()].sort((a, b) => b[1] - a[1])
  const dups = items.filter((it) => it.dup).length
  return [
    h('div', { class: 'feed-stat' },
      h('span', { class: 'feed-stat-num' }, String(items.length)),
      h('span', { class: 'feed-stat-label' }, '条数据'),
    ),
    h('div', { class: 'feed-stat' },
      h('span', { class: 'feed-stat-num' }, String(items.length - dups)),
      h('span', { class: 'feed-stat-label' }, '新'),
    ),
    h('div', { class: 'feed-stat' },
      h('span', { class: 'feed-stat-num', style: { color: 'var(--teal)' } }, String(dups)),
      h('span', { class: 'feed-stat-label' }, '重复'),
    ),
    h('div', { class: 'feed-stat-kinds' },
      ...sorted.map(([k, n]) => h('span', { class: 'feed-stat-kind' },
        h('span', { class: 'feed-dot', style: { background: kindColor(k) } }),
        h('span', {}, k),
        h('span', { style: { color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' } }, String(n)),
      )),
    ),
  ]
}