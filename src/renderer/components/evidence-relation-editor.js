import { h, toast } from '../lib/dom.js'

/** Add user-supplied evidence with explicit provenance and a supports relation. */
export function renderEvidenceComposer(theme, node, opts = {}, onClose = () => {}) {
  const m = globalThis.window?.meridian || {}
  const text = h('textarea', { class: 'txt cog-entry-textarea', rows: '3', required: true, placeholder: '记录可核对的数字、观察或原文摘录', 'aria-label': '证据摘要或原文摘录' })
  const source = h('input', { class: 'txt', placeholder: '来源名称（可选）', 'aria-label': '来源名称' })
  const url = h('input', { class: 'txt', type: 'url', placeholder: 'https://…（可选）', 'aria-label': '来源链接' })
  const publishedAt = h('input', { class: 'txt', type: 'text', maxlength: '100', placeholder: '来源发布时间（可选）', 'aria-label': '来源发布时间' })
  const applicability = h('input', { class: 'txt', type: 'text', maxlength: '160', placeholder: '如 2026Q2（可选）', 'aria-label': '证据适用时间' })
  const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const form = h('form', { class: 'cog-entry-form' },
    h('p', { class: 'cog-entry-note' }, '这会追加一条证据记录，并由你明确声明它支持此观点；来源真实性不会被自动验证。'),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '证据摘要或原文摘录'), text),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '来源名称（可选）'), source),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '来源链接（可选）'), url),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '来源发布时间（可选）'), publishedAt),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '适用时间（可选）'), applicability),
    error,
    h('button', { type: 'submit', class: 'btn btn-primary' }, '追加证据'))
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!text.value.trim()) { error.hidden = false; error.textContent = '请填写证据摘要或原文摘录。'; text.focus(); return }
    const button = form.querySelector('button[type="submit"]')
    button.disabled = true
    try {
      const result = await m.chainAddEvidence(theme.id, node.id, {
        text: text.value.trim(), sourceLabel: source.value.trim(), url: url.value.trim(),
        sourcePublishedAt: publishedAt.value.trim(), applicability: applicability.value.trim(),
      })
      if (result?.ok === false) throw new Error(result.error || '保存未完成')
      toast('已追加证据与支持关系')
      onClose()
      opts.onChanged?.()
    } catch (saveError) {
      error.hidden = false
      error.textContent = saveError.message || String(saveError)
      button.disabled = false
    }
  })
  return h('section', { class: 'chain-dsect cog-action-section' },
    h('details', { class: 'cog-action-disclosure' }, h('summary', {}, '补充证据'), form))
}
