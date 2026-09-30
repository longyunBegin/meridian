/**
 * 60 秒成片《一根弦》的完整时间轴。画面（film.html）与声音（audio.mjs）只读这一份数据。
 * 所有随机性都来自固定种子，重复构建结果一致。
 *
 * 七幕：
 *   S1  0–5    一根弦被拨响
 *   S2  5–11   噪音：上千根弦乱响，11.0 秒硬切
 *   S3  11–17  ⌘⇧V：一根弦被理直，搬进收件箱
 *   S4  17–27  一句话织出产业链，每条边带权重
 *   S5  27–38  拨弦：真实引擎的传导，直到自己停下
 *   S6  38–52  结算与校准曲线
 *   S7  52–60  收拢成 Logo，片尾
 */
import { buildTimeline, LAYOUT, PITCH, W, H, FPS, PX_PER_POINT } from './timeline.mjs'

export const DURATION = 60

export const SCENES = {
  s1: [0, 5], s2: [5, 11], s3: [11, 17], s4: [17, 27], s5: [27, 38], s6: [38, 52], s7: [52, 60],
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const easeInOut = (x) => { const t = Math.max(0, Math.min(1, x)); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }

/** S2 的噪音弦：位置、出场时刻与每次被拨的参数。画面画振动，声音按同一张表拨弦。 */
function buildNoise() {
  const rnd = mulberry32(5150)
  const [t0, t1] = SCENES.s2
  const threads = []
  for (let i = 0; i < 96; i++) {
    const angle = (rnd() - 0.5) * (rnd() < 0.2 ? 2.6 : 1.1)
    const cx = 80 + rnd() * (W - 160)
    const cy = 90 + rnd() * (H - 260)
    const appear = t0 + 0.15 + 4.6 * Math.pow(rnd(), 1.4)
    const plucks = []
    let pt = appear
    while (pt < t1) {
      plucks.push({ t: pt, amp: 7 + rnd() * 22, f: 3 + rnd() * 5, s0: 0.2 + rnd() * 0.6 })
      const density = (pt - t0) / (t1 - t0) // 越往后越密
      pt += 0.25 + rnd() * (1.6 - 1.3 * density)
    }
    threads.push({ cx, cy, angle, appear, alpha: 0.18 + rnd() * 0.32, plucks })
  }
  const heads = [
    '突发：行业迎来拐点', '内部人士：订单翻倍', '传闻：巨头削减开支', '专家：泡沫即将破裂',
    '快讯：出货超预期', '独家：新品提前发布', '重磅！政策即将落地', '据说：明天有大消息',
    '刚刚：某厂商紧急回应', '群聊转发：速看', '深度：十张图看懂', '最新：数据全面下滑',
    '热议：这次不一样', '爆料：供应链大变动', '紧急：价格战再升级', '独家解读：拐点已至',
  ]
  const headlines = heads.map((text, i) => ({
    text,
    x: 140 + rnd() * (W - 520),
    y: 120 + rnd() * (H - 330),
    t: t0 + 0.9 + (i / heads.length) * 4.4 + rnd() * 0.3,
    size: 22 + Math.round(rnd() * 12),
  }))
  return { threads, headlines, cut: t1 }
}

/** S6 日期翻页：从今天滚到结算日，每跨过 4 天响一声。 */
function buildDateRoll() {
  const from = Date.UTC(2026, 8, 29)
  const to = Date.UTC(2026, 11, 31)
  const days = Math.round((to - from) / 864e5)
  const t0 = 39.4, t1 = 41.4
  const ticks = []
  // 反解缓动：逐帧扫描，天数跨过 4 的倍数时记一声
  let last = 0
  for (let f = Math.round(t0 * FPS); f <= Math.round(t1 * FPS); f++) {
    const t = f / FPS
    const d = Math.round(days * easeInOut((t - t0) / (t1 - t0)))
    if (Math.floor(d / 4) > Math.floor(last / 4)) ticks.push(t)
    last = d
  }
  return { from, to, days, t0, t1, ticks }
}

export function buildFilm(chain, calib, assets) {
  const pluck = buildTimeline(chain, { tImpact: 28.4, hop: 0.8 })
  const noise = buildNoise()
  const dateRoll = buildDateRoll()

  const judged = pluck.nodes.find((n) => n.key === 'apps')
  const settleDate = '2026-12-31'
  const path = ['optics', 'capex', 'apps'].map((k) => pluck.nodes.find((n) => n.key === k).title).join(' / ')

  // S4：珍珠按从左到右的顺序打结到弦上，支线稍后长出
  const popOrder = ['optics', 'capex', 'apps', 'power', 'paying', 'renew', 'produce']
  const pops = {}
  popOrder.forEach((k, i) => { pops[k] = 19.9 + i * 0.4 })
  const weightFlash = pluck.edges.map((e, i) => ({ from: e.from, to: e.to, t: 23.4 + i * 0.28 }))

  // S6：校准快照的出场时刻；每个快照都必须覆盖全部信心档位，否则曲线会缺点
  const snapTimes = [45.0, 46.5, 47.9, 49.2, 50.4]
  if (snapTimes.length !== calib.snapshots.length) throw new Error('校准快照数与出场时刻数不一致')
  for (const snap of calib.snapshots) {
    for (const c of calib.confidences) {
      const bucket = Math.min(10, Math.floor(c / 10)) * 10
      if (!snap.buckets.some((b) => b.bucket === bucket)) throw new Error(`已结算 ${snap.settled} 条时缺少 ${bucket} 档`)
    }
  }

  // S7：Logo 原图（800px）里六颗珍珠的位置，按图片像素标定
  const logoPearls = [[447, 150], [309, 273], [476, 310], [238, 360], [367, 480], [328, 657]]

  const subtitles = [
    { from: 1.4, to: 4.6, text: '每一条消息，都会拨动点什么。' },
    { from: 6.0, to: 10.7, text: '可你听到的，只有噪音。' },
    { from: 11.6, to: 16.6, text: '你不用写。选中，⌘⇧V，搬进来。' },
    { from: 17.6, to: 21.8, text: '一句话，织出一整条产业链。' },
    { from: 22.2, to: 26.6, text: '每条边，都有传导权重。' },
    { from: 28.3, to: 30.9, text: '拨一下上游，整条链都会响。' },
    { from: 31.1, to: 33.5, text: '越往下，越轻。' },
    { from: 33.8, to: 37.4, text: '直到它自己停下。' },
    { from: 38.4, to: 41.2, text: '每个判断都有到期日。' },
    { from: 41.6, to: 43.9, text: '到期那天，它会回来问你。' },
    { from: 44.3, to: 48.1, text: '你说七成把握的事，到底发生了几次？' },
    { from: 48.5, to: 51.6, text: '每结算一次，就准一点。' },
  ]

  // ------------------------------------------------------------------ 声音事件
  const audio = []
  const add = (ev) => {
    if (!Number.isFinite(ev.t) || ev.t < 0 || ev.t >= DURATION) throw new Error(`音频事件时刻越界：${JSON.stringify(ev)}`)
    audio.push(ev)
  }
  // S1
  add({ type: 'pluck', t: 1.0, freq: 146.83, amp: 0.85, pan: -0.2, t60: 3.6 })
  // S2：每次拨动一个音，音高随机（刻意不成调），走噪音总线，11.0 秒一刀切
  const nrnd = mulberry32(777)
  const noiseFreqs = [98, 116.5, 138.6, 155.6, 185, 207.7, 233.1, 277.2, 311.1, 369.9, 415.3]
  for (const th of noise.threads) {
    for (const p of th.plucks) {
      add({ type: 'pluck', bus: 'noise', t: p.t, freq: noiseFreqs[Math.floor(nrnd() * noiseFreqs.length)] * (1 + (nrnd() - 0.5) * 0.03), amp: 0.05 + (p.amp / 29) * 0.07, pan: (th.cx / W) * 2 - 1, t60: 1.6 })
    }
  }
  // S3
  add({ type: 'click', t: 12.2, amp: 0.55 })
  add({ type: 'click', t: 12.5, amp: 0.22 })
  add({ type: 'pluck', t: 13.25, freq: 293.66, amp: 0.5, pan: 0, t60: 3.0 })
  add({ type: 'pluck', t: 13.6, freq: 587.33, amp: 0.14, pan: 0, t60: 1.2 })
  // S4
  for (const tt of [17.5, 17.8, 18.1]) add({ type: 'click', t: tt, amp: 0.16, light: true })
  for (const k of popOrder) {
    const n = pluck.nodes.find((x) => x.key === k)
    add({ type: 'pluck', t: pops[k], freq: PITCH[k] * 2, amp: 0.16, pan: (n.x / W) * 2 - 1, t60: 1.6 })
  }
  // S5：直接用传导时间轴，响度 = |变化量| / 源头变化量
  add({ type: 'impact', t: pluck.impact.t, amp: 0.35 })
  for (const ev of pluck.audio) add({ type: 'pluck', t: ev.t, freq: ev.freq, amp: ev.amp, pan: ev.pan, t60: ev.muted ? 0.35 : 3.2, muted: !!ev.muted })
  // S6
  for (const tt of dateRoll.ticks) add({ type: 'click', t: tt, amp: 0.07, light: true })
  add({ type: 'pluck', t: 42.3, freq: 440, amp: 0.14, pan: 0, t60: 1.8 })
  add({ type: 'pluck', t: 42.45, freq: 587.33, amp: 0.12, pan: 0, t60: 1.8 })
  add({ type: 'click', t: 43.4, amp: 0.3 })
  add({ type: 'pluck', t: 43.42, freq: 293.66, amp: 0.3, pan: 0, t60: 2.4 })
  snapTimes.forEach((st) => {
    calib.confidences.forEach((c, i) => add({ type: 'pluck', t: st + i * 0.045, freq: 293.66 * Math.pow(2, i / 5), amp: 0.06, pan: -0.5 + i * 0.25, t60: 1.2 }))
  })
  audio.push({ type: 'drone', t: 44.8, end: 51.6, freq: 220, detuneFrom: 0.035, amp: 0.1 })
  // S7
  logoPearls.forEach((_, i) => add({ type: 'pluck', t: 55.2 + i * 0.18, freq: [146.83, 220, 293.66, 349.23, 440, 587.33][i], amp: 0.2, pan: -0.4 + i * 0.16, t60: 2.6 }))
  add({ type: 'pluck', t: 57.0, freq: 73.42, amp: 0.75, pan: 0, t60: 6 })

  return {
    W, H, FPS, DURATION, PX_PER_POINT, SCENES,
    pluck,
    noise,
    dateRoll,
    s3: { pressT: 12.2, releaseT: 12.5, straightenT: [12.35, 13.3], pearlT: 13.6 },
    s4: { typeTimes: [17.5, 17.8, 18.1], typed: chain.theme, pops, weightFlash },
    s6: {
      judged: { key: judged.key, title: judged.title, confidence: judged.after, date: settleDate, path },
      snapTimes,
      calib,
    },
    s7: { logo: assets.logo, logoSize: 800, logoPearls },
    subtitles,
    fadeOutFrom: 59,
    audio,
    gates: [{ bus: 'noise', t: noise.cut }],
  }
}
