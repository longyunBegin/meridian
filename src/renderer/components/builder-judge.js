import { h, toast } from '../lib/dom.js'
import { JUDGE_KIND_LABEL, JUDGE_STANCE_LABEL, JUDGE_STANCE_ORDER } from '../lib/judge-queue.js'
import {
  DEFAULT_SOURCE_TYPE, HARDNESS, HARDNESS_ORDER, SOURCE_QUALITY, SOURCE_VIA_LABEL, WEIGHT_TIER_LABEL,
  weightFormula, weightOf, weightText, weightTier,
} from '../../shared/evidence-weight.js'
import { checkSourceUrl } from '../../shared/evidence-source.js'

const KEY_OF_STANCE = { supports: '1', contradicts: '2', related: '3', irrelevant: '4' }

const dateText = (date) => (date ? `${date.day} ${date.kind}` : '日期未记录')

const WEIGHT_ORIGIN_TEXT = {
  judged: '判定时确认过的权重',
  suggested: '进主题时按规则给的建议',
  estimated: '旧数据没记权重，按同一规则现算的建议',
  draft: '你改过、还没落账的权重',
}

/*
 * 判卡草稿：队列随 db:changed 重渲染时判卡会整张重建，人已选的原子 / 改过的权重不能因此丢掉。
 * 键 = 主题 + 队列项（事件 id / 节点 id，稳定）；只存人动过的部分，判成功后清掉。
 * Map 按插入顺序淘汰，上限防止长时间不判的草稿无界增长。
 */
const MAX_JUDGE_DRAFTS = 200
const judgeDrafts = new Map()
const draftKey = (themeId, item) => `${themeId || ''}\u0000${item?.key || ''}`
function saveDraft(key, change) {
  const next = { ...(judgeDrafts.get(key) || {}), ...change }
  judgeDrafts.delete(key)
  judgeDrafts.set(key, next)
  while (judgeDrafts.size > MAX_JUDGE_DRAFTS) judgeDrafts.delete(judgeDrafts.keys().next().value)
}

/**
 * 权重控件：权重 = 来源类型分 × 硬度系数。人改来源类型 / 硬度，分值即时重算；
 * 落账的只是 { sourceType, hardness }，分值由后端用同一张表重算。
 * draftWeight：这张卡上次被人改过、还没落账的 { sourceType, hardness }，有就从它开始。
 */
function renderWeightControl(initial, { draftWeight = null, onChange = null } = {}) {
  const drafted = weightOf(draftWeight)
  const start = drafted || weightOf(initial?.weight) || weightOf({ sourceType: DEFAULT_SOURCE_TYPE, hardness: 'soft' })
  let current = start
  const value = h('strong', { class: 'judge-weight-value' })
  const formula = h('span', { class: 'judge-weight-formula' })
  const typeSelect = h('select', { class: 'judge-weight-type', 'aria-label': '来源类型' },
    ...SOURCE_QUALITY.map(([type, quality]) => h('option', { value: type }, `${type} ${quality.toFixed(2)}`)))
  typeSelect.value = start.sourceType
  const hardButtons = new Map(HARDNESS_ORDER.map((key) => [key, h('button', {
    type: 'button', class: 'judge-hardness-btn', 'data-hardness': key,
    onclick: () => update({ hardness: key }),
  }, `${HARDNESS[key].label} ×${HARDNESS[key].factor.toFixed(1)}`)]))
  const sync = () => {
    const tier = weightTier(current)
    value.textContent = `${weightText(current)} · ${WEIGHT_TIER_LABEL[tier]}`
    value.className = `judge-weight-value is-${tier}`
    formula.textContent = `= ${weightFormula(current)}`
    for (const [key, button] of hardButtons) button.setAttribute('aria-pressed', String(key === current.hardness))
  }
  const via = !drafted && initial?.sourceVia ? `；来源类型${SOURCE_VIA_LABEL[initial.sourceVia] || ''}` : ''
  const origin = h('span', { class: 'judge-weight-origin' },
    drafted ? WEIGHT_ORIGIN_TEXT.draft : `${WEIGHT_ORIGIN_TEXT[initial?.source] || WEIGHT_ORIGIN_TEXT.estimated}${via}`)
  function update(change) {
    current = weightOf({ ...current, ...change }) || current
    sync()
    // 权重数字变化：u-num-bump 轻量回弹（重触发）
    value.classList.remove('u-num-bump')
    void value.offsetWidth
    value.classList.add('u-num-bump')
    origin.textContent = WEIGHT_ORIGIN_TEXT.draft
    onChange?.({ sourceType: current.sourceType, hardness: current.hardness })
  }
  typeSelect.addEventListener('change', () => update({ sourceType: typeSelect.value }))
  sync()
  const element = h('div', { class: 'judge-weight' },
    h('div', { class: 'judge-weight-row' },
      h('span', { class: 'judge-weight-label' }, '权重'),
      value,
      typeSelect,
      h('span', { class: 'judge-weight-times', 'aria-hidden': 'true' }, '×'),
      h('div', { class: 'judge-hardness', role: 'group', 'aria-label': '硬度' }, ...hardButtons.values())),
    h('p', { class: 'judge-weight-note' }, formula, ' · ', origin, '。只有佐证 / 反对按权重推动原子强度。'))
  return {
    element,
    value: () => ({ sourceType: current.sourceType, hardness: current.hardness }),
    current: () => current,
  }
}

/** 判卡底部：归档 / 冷冻（外部数据维度；走 chain:shelfJudgeItem）。 */
function renderShelfActions({ item, themeId, api, onJudged, busyRef }) {
  const archiveBox = h('div', { class: 'judge-shelf', hidden: true })
  const archiveReason = h('input', {
    class: 'txt', type: 'text', maxlength: '500',
    placeholder: '归档原因（必填）', 'aria-label': '归档原因',
  })
  const archiveConfirm = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, '确认归档')
  const status = h('p', { class: 'judge-shelf-status', role: 'status', hidden: true })
  const setBusy = (on) => {
    busyRef.shelf = on
    archiveBtn.disabled = on
    freezeBtn.disabled = on
    archiveConfirm.disabled = on
  }
  const shelf = async (mode) => {
    if (busyRef.judge || busyRef.shelf) return
    if (mode === 'archive') {
      const reason = archiveReason.value.trim()
      if (!reason) {
        archiveBox.hidden = false
        status.hidden = false
        status.textContent = '请填写归档原因'
        archiveReason.focus()
        return
      }
    }
    setBusy(true)
    status.hidden = false
    status.textContent = mode === 'park' ? '正在冷冻…' : '正在归档…'
    try {
      const response = await api.chainShelfJudgeItem(themeId, {
        kind: item.kind,
        id: item.id,
        mode,
        reason: mode === 'archive' ? archiveReason.value.trim() : '',
        fallbackSourceUrl: item.urlVia === 'inbox' ? item.url : null,
      })
      if (response?.ok === false) throw new Error(response.error || '操作未完成')
      judgeDrafts.delete(draftKey(themeId, item))
      toast(mode === 'park' ? '已冷冻，可在侧栏冷库查看' : '已归档，可在侧栏归档找回')
      onJudged?.({ item, stance: null, atomId: null, shelved: mode === 'park' ? 'cold' : 'archived' })
    } catch (error) {
      setBusy(false)
      status.hidden = false
      status.textContent = `${mode === 'park' ? '冷冻' : '归档'}失败：${error?.message || error}`
      toast(`${mode === 'park' ? '冷冻' : '归档'}失败：${error?.message || error}`, 'var(--red)')
    }
  }
  const archiveBtn = h('button', {
    type: 'button', class: 'btn btn-sm judge-shelf-btn',
    title: '归档这条外部数据；可在侧栏「归档」找回',
    onclick: () => {
      if (archiveBox.hidden) {
        archiveBox.hidden = false
        archiveReason.focus()
      } else shelf('archive')
    },
  }, '归档')
  const freezeBtn = h('button', {
    type: 'button', class: 'btn btn-sm judge-shelf-btn',
    title: '冷冻这条外部弱信号；可在侧栏「冷库」解冻（不碰权重）',
    onclick: () => shelf('park'),
  }, '冷冻')
  archiveConfirm.onclick = () => shelf('archive')
  archiveBox.append(
    h('p', { class: 'judge-shelf-note' }, '归档针对这条外部数据，不是主题原子。只追加事件，可在侧栏「归档」恢复。'),
    archiveReason, archiveConfirm)
  return h('footer', { class: 'judge-shelf-foot', 'aria-label': '外部数据归档与冷冻' },
    h('div', { class: 'judge-shelf-actions' }, archiveBtn, freezeBtn),
    archiveBox, status,
    h('p', { class: 'judge-shelf-note' }, '归档进「归档」；冷冻进「冷库」。两者都让这条数据离开待判队列。'))
}

/**
 * 建设者「判」的一张卡：一条数据 → 判给哪个原子 → 佐证 / 反对 / 中立 / 不相关，一次点击落账。
 * 写入：模型建议走 chain:reviewEngineRecommendation（接受时带 targetNodeId + rel，不相关 = 驳回）；
 *       证据走 chain:judgeEvidence。成功后交给 onJudged 刷新，队列自然前进到下一条。
 * 底部固定：归档 / 冷冻（chain:shelfJudgeItem），维度是外部数据。
 */
export function renderJudgeCard({ item, atoms = [], themeId, api, onJudged }) {
  const suggestion = item.suggestion || {}
  const atomSelect = h('select', { class: 'judge-atom', 'aria-label': '判给哪个原子' },
    h('option', { value: '' }, atoms.length ? '选一个原子…' : '这个主题还没有原子'),
    ...atoms.map((atom) => h('option', { value: atom.id }, atom.title)))
  const draftId = draftKey(themeId, item)
  const draft = judgeDrafts.get(draftId) || {}
  const draftAtomValid = typeof draft.atomId === 'string' && (draft.atomId === '' || atoms.some((atom) => atom.id === draft.atomId))
  atomSelect.value = draftAtomValid ? draft.atomId : (suggestion.atomId || '')
  const status = h('p', { class: 'judge-status', role: 'status' })
  const weightControl = renderWeightControl(item.weight, {
    draftWeight: draft.weight,
    onChange: (weight) => saveDraft(draftId, { weight }),
  })
  const buttons = new Map()
  const busyRef = { judge: false, shelf: false }

  const syncButtons = () => {
    const hasAtom = Boolean(atomSelect.value)
    for (const [stance, button] of buttons) {
      const needsAtom = stance !== 'irrelevant'
      button.disabled = busyRef.judge || busyRef.shelf || (needsAtom && (!hasAtom || !item.quoteVerified))
    }
  }

  const judge = async (stance) => {
    const button = buttons.get(stance)
    if (busyRef.judge || busyRef.shelf || !button || button.disabled) return
    const atomId = atomSelect.value || null
    busyRef.judge = true
    syncButtons()
    status.textContent = '正在写入…'
    try {
      let response
      const weight = weightControl.value()
      if (item.kind === 'proposal') {
        const corrected = atomId !== (suggestion.atomId || null) || stance !== suggestion.stance
        response = stance === 'irrelevant'
          ? await api.chainReviewEngineRecommendation(themeId, item.id, 'rejected', {})
          : await api.chainReviewEngineRecommendation(themeId, item.id, corrected ? 'corrected' : 'accepted', { targetNodeId: atomId, rel: stance, weight })
      } else {
        response = await api.chainJudgeEvidence(themeId, item.id, stance === 'irrelevant' ? { stance, atomId } : { stance, atomId, weight })
      }
      if (response?.ok === false) throw new Error(response.error || '写入失败')
      judgeDrafts.delete(draftId)
      const atomTitle = atoms.find((atom) => atom.id === atomId)?.title
      toast(stance === 'irrelevant' ? '已判为不相关，不计入任何原子'
        : `已判：${JUDGE_STANCE_LABEL[stance]} · ${atomTitle || ''} · 权重 ${weightText(weightControl.current())}`)
      onJudged?.({ item, stance, atomId })
    } catch (error) {
      busyRef.judge = false
      syncButtons()
      status.textContent = ''
      toast(`没能写入：${error?.message || error}`, 'var(--red)')
    }
  }

  for (const stance of JUDGE_STANCE_ORDER) {
    const suggested = suggestion.stance === stance && stance !== 'irrelevant'
    const button = h('button', {
      type: 'button',
      class: `btn judge-btn is-${stance}${suggested ? ' is-suggested' : ''}`,
      'data-stance': stance,
      title: `${JUDGE_STANCE_LABEL[stance]}（按 ${KEY_OF_STANCE[stance]}）`,
      onclick: () => judge(stance),
    }, JUDGE_STANCE_LABEL[stance], h('kbd', {}, KEY_OF_STANCE[stance]))
    buttons.set(stance, button)
  }
  atomSelect.addEventListener('change', () => {
    saveDraft(draftId, { atomId: atomSelect.value })
    syncButtons()
  })
  syncButtons()

  const hint = item.kind === 'proposal'
    ? `模型建议：${JUDGE_STANCE_LABEL[suggestion.stance] || '—'}${suggestion.atomTitle ? ` · ${suggestion.atomTitle}` : ''}${suggestion.reason ? `。${suggestion.reason}` : ''}。可换原子或换表态；与建议不同会记成人工纠正。点「不相关」= 驳回。`
    : item.kind === 'pending'
      ? (suggestion.atomTitle ? `这条旧数据原来挂在「${suggestion.atomTitle}」上，但还没人确认它的表态。` : '这条旧数据还没人确认，先选它说的是哪个原子。')
      : '这条数据还没挂到任何原子上：先选它说的是哪个原子，再判表态。'
  const warning = item.quoteVerified ? null
    : h('p', { class: 'judge-warning', role: 'alert' }, '引文没能在原文里逐字核对上，不能作为证据计入；只能判为不相关。')

  const points = Array.isArray(item.points) ? item.points : []
  const card = h('article', { class: 'judge-card', tabindex: '-1', 'data-judge-key': item.key },
    h('header', { class: 'judge-head' },
      h('span', { class: `judge-kind is-${item.kind}` }, JUDGE_KIND_LABEL[item.kind] || '待判'),
      h('span', { class: 'judge-source' }, item.sourceName || '来源未标注'),
      h('span', { class: 'judge-date' }, dateText(item.date)),
      item.url
        ? h('button', {
          type: 'button', class: 'judge-link', 'data-url-via': item.urlVia || 'recorded',
          title: item.urlVia === 'inbox' ? `${item.url}\n这条建议生成时还没有链接，取自原条目后补的链接；采纳时一并写进证据` : item.url,
          onclick: () => api.openExternal?.(item.url),
        }, '原文 ↗')
        : h('span', { class: 'judge-nolink', title: '外部数据必须指向真实的来源网址；这条旧数据没有记下' }, '缺来源链接')),
    h('blockquote', { class: 'judge-quote' }, item.quote || '（没有引文）'),
    points.length
      ? h('div', { class: 'judge-points' },
        h('h4', { class: 'judge-points-title' }, `要点 · ${points.length}`),
        h('ul', {}, ...points.map((point) => h('li', {}, point))),
        h('p', { class: 'judge-points-note' }, '要点是抽取时从原文里列出的，只作判断的上下文；判的仍是上面这段原文。'))
      : null,
    h('label', { class: 'judge-target' }, h('span', {}, '判给'), atomSelect),
    h('p', { class: 'judge-hint' }, hint),
    weightControl.element,
    warning,
    h('div', { class: 'judge-actions', role: 'group', 'aria-label': '这条数据对该原子的表态' }, ...buttons.values()),
    status,
    h('p', { class: 'judge-note' }, '模型建议只是初值。判完立刻计入读者页；中立 = 提到它但不表态，不相关 = 驳回、不计入任何原子。'),
    renderShelfActions({ item, themeId, api, onJudged, busyRef }))

  card.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    const stance = Object.keys(KEY_OF_STANCE).find((key) => KEY_OF_STANCE[key] === event.key)
    if (!stance) return
    event.preventDefault()
    judge(stance)
  })
  return card
}

/** 建设者「读入来源」：粘贴原文或链接，交给模型（测试环境为 mock）读出表态建议，进入待判。 */
export function renderFeedForm({ themeId, api, onFed, onCancel }) {
  const textInput = h('textarea', { class: 'txt feedform-text', rows: '6', placeholder: '粘贴原文，或一条链接', 'aria-label': '原文或链接' })
  const urlInput = h('input', {
    class: 'txt feedform-url', type: 'url', maxlength: '2048', placeholder: '来源链接（必填，原文所在网页的 http / https 网址）', 'aria-label': '来源链接',
  })
  const sourceInput = h('input', { class: 'txt feedform-source', type: 'text', maxlength: '80', placeholder: '来源名称（可选）', 'aria-label': '来源名称' })
  const dateInput = h('input', { class: 'txt feedform-date', type: 'date', 'aria-label': '原文发布日期（可选）' })
  const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const submit = h('button', { type: 'button', class: 'btn btn-primary' }, '读入')
  submit.addEventListener('click', async () => {
    const value = textInput.value.trim()
    if (!value) {
      error.hidden = false
      error.textContent = '先粘贴原文或链接。'
      textInput.focus()
      return
    }
    /* 粘贴的就是一条链接时，它本身就是来源；粘贴原文时必须另填来源链接。后端按同一口径再校验一次。 */
    const pastedIsLink = /^https?:\/\/\S+$/i.test(value)
    const typedUrl = urlInput.value.trim()
    const checked = checkSourceUrl(pastedIsLink ? value : typedUrl)
    if (!checked.ok) {
      error.hidden = false
      error.textContent = pastedIsLink || typedUrl ? `来源链接不可用：${checked.error}` : '外部数据必须带来源链接：请填上原文所在网页的网址。'
      ;(pastedIsLink ? textInput : urlInput).focus()
      return
    }
    submit.disabled = true
    error.hidden = true
    submit.textContent = '正在读…'
    try {
      const response = await api.themeFeed(themeId, { text: value, url: checked.url, sourceLabel: sourceInput.value.trim(), publishedAt: dateInput.value })
      if (!response?.ok) throw new Error(response?.error || '没能读入')
      const mockMark = response.mocked ? '（mock）' : ''
      toast(response.stanceProposals
        ? `已读完${mockMark}：${response.stanceProposals} 条表态建议进入待判`
        : response.engineError
          ? `模型没跑成（${response.engineError}）；原文已作为还没挂原子的数据进入待判`
          : `已读完${mockMark}：没提到现有原子，原文已作为还没挂原子的数据进入待判`)
      onFed?.(response)
    } catch (cause) {
      error.hidden = false
      error.textContent = cause?.message || String(cause)
      submit.disabled = false
      submit.textContent = '读入'
    }
  })
  requestAnimationFrame(() => textInput.focus())
  return h('section', { class: 'feedform-card', 'aria-labelledby': 'feedform-title' },
    h('h3', { id: 'feedform-title' }, '读入一条来源'),
    h('p', { class: 'feedform-desc' }, '模型读完会给出"它对哪个原子是佐证 / 反对 / 中立"的建议，进入左侧待判；没提到任何原子的，原文整条进入待判，由你挂原子。'),
    textInput,
    urlInput,
    h('div', { class: 'feedform-row' }, sourceInput, dateInput),
    error,
    h('div', { class: 'feedform-actions' },
      onCancel ? h('button', { type: 'button', class: 'btn', onclick: onCancel }, '取消') : null,
      submit))
}
