/**
 * Mock 引擎（MERIDIAN_MOCK_ENGINE=1）：不调 LLM，按原文与原子标题的字面重合给出确定性的归因建议，供界面与流程测试。
 *
 * 规则（同样输入永远同样输出）：
 * - 句子：原文空白归一后按 。！？!?；; 切句；引文就是整句原文，逐字片段，核验闸门照常生效。
 * - 相关：原子标题拆成中文二字组 + 拉丁词，某句命中的比例 ≥ MATCH_RATIO 才算提到该原子；
 *   排序：命中比例降序 → 命中数降序 → 账本顺序；最多 MAX_TARGETS 个原子。
 * - 表态：只看引文那一句的线索词——只有正向 → 佐证，只有反向 → 反对，都没有或两者都有 → 中立（相关）。
 * - 一个原子都没提到：只给一条"新建原子"建议（取第一句），由人决定要不要拆出新原子。
 * 不预设任何领域；数值只取引文里出现的数字，时间窗口只取原文写明的。
 */

import { TIME_WINDOW_PATTERN as TIME_WINDOW, quantityOf } from '../shared/evidence-weight.js'

export { quantityOf }
export const MATCH_RATIO = 0.5
export const MAX_TARGETS = 2
const POSITIVE_CUES = /增长|提升|上升|上调|突破|超预期|扩产|满产|翻倍|加速|领先|高于|新高|改善|放量|中标|回升/
const NEGATIVE_CUES = /下降|下滑|下调|放缓|推迟|延迟|延期|低于|不及|质疑|风险|瓶颈|减少|亏损|收缩|取消|恶化|流失|回落/

const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

export function splitSentences(body) {
  return squash(body).split(/(?<=[。！？!?；;])/).map((sentence) => sentence.trim()).filter(Boolean)
}

/** 标题 → 去重的匹配单元：连续中文取二字组（单字标题取单字），拉丁 / 数字取 ≥2 字符的词（小写）。 */
export function titleTokens(title) {
  const tokens = new Set()
  const text = squash(title)
  for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2))
  }
  for (const word of text.toLowerCase().match(/[a-z0-9]{2,}/g) || []) tokens.add(word)
  return [...tokens]
}

export function stanceOfSentence(sentence) {
  const positive = POSITIVE_CUES.test(sentence)
  const negative = NEGATIVE_CUES.test(sentence)
  if (positive && !negative) return 'supports'
  if (negative && !positive) return 'contradicts'
  return 'related'
}

/** 每个原子取命中最好的一句；返回按规则排好序的命中列表。 */
export function rankAtomMentions(sentences, atoms) {
  const lowered = sentences.map((sentence) => sentence.toLowerCase())
  const mentions = []
  asArray(atoms).forEach((atom, rank) => {
    const tokens = titleTokens(atom?.title)
    if (!atom?.id || !tokens.length) return
    let best = null
    lowered.forEach((sentence, index) => {
      const hits = tokens.filter((token) => sentence.includes(token)).length
      if (!hits) return
      const ratio = hits / tokens.length
      if (!best || ratio > best.ratio || (ratio === best.ratio && hits > best.hits)) best = { index, hits, ratio }
    })
    if (best && best.ratio >= MATCH_RATIO) mentions.push({ atom, rank, sentence: sentences[best.index], hits: best.hits, ratio: best.ratio })
  })
  return mentions.sort((a, b) => b.ratio - a.ratio || b.hits - a.hits || a.rank - b.rank)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

const REASON = {
  supports: '引文出现正向线索',
  contradicts: '引文出现反向线索',
  related: '引文提到它，但没有明确方向',
}

/**
 * @param {{ title?: string, text?: string }} item 收件箱条目
 * @param {Array<{ id: string, title: string, status?: string }>} atoms 主题内未归档、未失效的原子，按账本顺序
 */
export function buildMockPipeline(item, atoms = []) {
  const sentences = splitSentences(item?.text)
  const subject = squash(item?.title).slice(0, 60) || '未命名来源'
  const timeMatch = squash(item?.text).match(TIME_WINDOW)
  const timeWindow = timeMatch ? timeMatch[0].replace(/\s+/g, '') : ''
  const statementOf = (attribute, sentence, type) => {
    const number = quantityOf(sentence)
    return {
      subject, attribute, value: number ? `${number[1]}${number[2] || ''}` : '未量化',
      timeWindow, type, sourceText: sentence,
    }
  }
  const results = rankAtomMentions(sentences, atoms).slice(0, MAX_TARGETS).map((mention) => {
    const rel = stanceOfSentence(mention.sentence)
    const statement = statementOf(mention.atom.title, mention.sentence, quantityOf(mention.sentence) ? 'hard' : 'soft')
    return {
      kind: 'evidence',
      statement,
      match: { propositionId: mention.atom.id, score: Math.round(mention.ratio * 100) / 100 },
      attribution: {
        rel, strength: 0.6,
        reason: `Mock：原文提到「${mention.atom.title}」，${REASON[rel]}`,
        change: { note: `Mock：${REASON[rel]}` },
      },
      proposition: { id: mention.atom.id, title: mention.atom.title, status: mention.atom.status || 'pending' },
      metaCount: 0,
      metaMultiplier: 1,
    }
  })
  if (!results.length && sentences.length) {
    const statement = statementOf('新观察', sentences[0], 'soft')
    results.push({
      kind: 'new-proposition',
      statement,
      match: null,
      proposition: null,
      suggestedTitle: sentences[0].replace(/[。！？!?；;]$/, '').slice(0, 40),
      attribution: {
        rel: 'related', strength: 0.5,
        reason: 'Mock：原文没有提到任何现有原子，建议新建原子',
        change: { note: 'Mock：建议新建原子' },
      },
      metaCount: 0,
      metaMultiplier: 1,
    })
  }
  return {
    statements: results.map((result) => result.statement),
    results,
    diagnostics: [],
    metaCount: 0,
    metaMultiplier: 1,
    status: 'done',
  }
}
