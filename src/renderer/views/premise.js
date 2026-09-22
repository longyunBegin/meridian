import { h, icon, clear } from '../lib/dom.js'
import { state, selectTheme } from '../app.js'

const m = window.meridian

/**
 * 共同前提：同一批 tag 出现在 ≥2 个主题里，就是跨主题共享的底层假设。
 * 值钱的地方在于——这不是跨领域的知识浪漫，是风险敞口的意外重叠。
 */
export async function renderPremise(mid) {
  clear(mid)
  const premises = await m.premises()

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '共同前提'),
      h('p', {}, '两个主题各自拆到了不同的树上，但底层是同一个原子。改变它，两边同时受影响。'),
    ),

    premises.length
      ? h('section', { class: 'sect' },
          h('div', { class: 'sect-h' }, h('h2', {}, '扫描结果'), h('em', {}, `${premises.length} 组`)),
          h('div', { class: 'sect-b' },
            ...premises.map((p) => h('div', { class: 'premise' },
              h('div', { class: 'premise-top' },
                h('span', { class: 'premise-name' }, p.tag),
                h('div', { class: 'premise-hit' },
                  h('b', {}, String(p.affected)),
                  h('span', {}, '条判断受影响'),
                ),
              ),
              h('div', { class: 'premise-arms' },
                ...p.themes.map((t) => h('div', { class: 'premise-arm' },
                  h('div', { class: 'th' }, `${t.name} · ${t.count} 条`),
                  ...t.branches.map((b) => h('div', { class: 'br' }, h('span', { class: 'dot' }), b)),
                  t.branches.length === 0 ? h('div', { class: 'br', style: { color: 'var(--text-3)' } }, '未归入环节') : null,
                )),
              ),
            )),
          ),
        )
      : h('section', { class: 'sect' },
          h('div', { class: 'sect-h' }, h('h2', {}, '还没有共同前提')),
          h('div', { class: 'sect-b' },
            h('div', { class: 'q' }, h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { color: 'var(--text-3)' } },
                '给不同主题的命题打上相同的底层概念标签（如「能源成本」「美元流动性」），它们就会在这里相遇。'),
              h('div', { class: 'q-meta', style: { marginTop: '6px' } }, '选中任意命题 → 检视栏「底层概念」→ 填标签'),
            )),
          ),
        ),

    h('div', { class: 'foot', style: { marginTop: '14px' } },
      h('b', {}, '为什么这比「知识连接」值钱：'),
      '它不是跨领域的知识浪漫，是',
      h('b', {}, '风险敞口的意外重叠'),
      '。你以为自己在两个不相关的主题上分散了下注，实际上共用同一个前提。',
    ),
  ))
}
