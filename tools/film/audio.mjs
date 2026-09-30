/**
 * 声音：全部由拨弦合成（Karplus–Strong），无外部素材、无版权问题。
 * 每个节点被传导到的时刻拨一次弦，响度 = |变化量| / 源头变化量，所以越往下游越轻。
 * 事件表来自 timeline.mjs，与画面共用同一时间轴。
 */

const SR = 48000

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 拨弦：延迟线 + 两点平均低通 + 一阶全通分数延迟（保证音高准确）。
 * 回路总延迟 = 整数延迟 + 0.5（平均滤波）+ frac（全通）= SR / freq。
 */
function pluckString({ freq, seconds, t60, brightness, seed }) {
  const P = SR / freq
  const nInt = Math.floor(P - 0.5)
  if (nInt < 2) throw new Error(`频率过高：${freq}Hz`)
  const frac = P - 0.5 - nInt
  const C = (1 - frac) / (1 + frac)
  const rho = Math.pow(0.001, 1 / (freq * t60))

  const rnd = mulberry32(seed)
  const line = new Float64Array(nInt)
  let lp = 0
  for (let i = 0; i < nInt; i++) {
    lp += brightness * ((rnd() * 2 - 1) - lp)
    line[i] = lp
  }
  let mean = 0
  for (let i = 0; i < nInt; i++) mean += line[i]
  mean /= nInt
  let peak = 0
  for (let i = 0; i < nInt; i++) { line[i] -= mean; peak = Math.max(peak, Math.abs(line[i])) }
  for (let i = 0; i < nInt; i++) line[i] /= peak || 1

  const out = new Float64Array(Math.round(seconds * SR))
  let idx = 0, prev = 0, apIn = 0, apOut = 0
  for (let n = 0; n < out.length; n++) {
    const y = line[idx]
    out[n] = y
    const avg = 0.5 * (y + prev) * rho
    prev = y
    const ap = C * avg + apIn - C * apOut
    apIn = avg
    apOut = ap
    line[idx] = ap
    idx = (idx + 1) % nInt
  }
  return out
}

function impactBody(seconds) {
  const out = new Float64Array(Math.round(seconds * SR))
  for (let n = 0; n < out.length; n++) {
    const t = n / SR
    const env = Math.min(1, t / 0.003) * Math.exp(-t / 0.18)
    out[n] = Math.sin(2 * Math.PI * 55 * t) * env
  }
  return out
}

function mixInto(L, R, sig, startSec, gain, pan) {
  const p = Math.max(-1, Math.min(1, pan)) * 0.7
  const gl = Math.cos((p + 1) * Math.PI / 4) * gain
  const gr = Math.sin((p + 1) * Math.PI / 4) * gain
  const s0 = Math.round(startSec * SR)
  for (let i = 0; i < sig.length; i++) {
    const k = s0 + i
    if (k < 0) continue
    if (k >= L.length) break
    L[k] += sig[i] * gl
    R[k] += sig[i] * gr
  }
}

/** Freeverb 结构的简化版：4 个带阻尼的梳状滤波 + 2 个全通。 */
function reverb(input, offset) {
  const scale = SR / 44100
  const combs = [1116, 1188, 1277, 1356].map((d) => ({ buf: new Float64Array(Math.round((d + offset) * scale)), i: 0, store: 0 }))
  const alls = [556, 441].map((d) => ({ buf: new Float64Array(Math.round((d + offset) * scale)), i: 0 }))
  const out = new Float64Array(input.length)
  const feedback = 0.8, damp = 0.3
  for (let n = 0; n < input.length; n++) {
    const x = input[n]
    let acc = 0
    for (const c of combs) {
      const y = c.buf[c.i]
      c.store = y * (1 - damp) + c.store * damp
      c.buf[c.i] = x + c.store * feedback
      c.i = (c.i + 1) % c.buf.length
      acc += y
    }
    acc /= combs.length
    for (const a of alls) {
      const b = a.buf[a.i]
      const y = -acc + b
      a.buf[a.i] = acc + b * 0.5
      a.i = (a.i + 1) % a.buf.length
      acc = y
    }
    out[n] = acc
  }
  return out
}

function toWav(L, R, seed) {
  const n = L.length
  const buf = Buffer.alloc(44 + n * 4)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40)
  const rnd = mulberry32(seed)
  const q = (x) => {
    const dithered = x * 32767 + (rnd() - rnd()) // TPDF 抖动
    return Math.max(-32768, Math.min(32767, Math.round(dithered)))
  }
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(q(L[i]), 44 + i * 4)
    buf.writeInt16LE(q(R[i]), 46 + i * 4)
  }
  return buf
}

/** 按键声：短噪声脉冲（机械感）+ 低频闷响；light 只有更短更亮的噪声。 */
function keyClick(light, seed) {
  const rnd = mulberry32(seed)
  const out = new Float64Array(Math.round(0.08 * SR))
  let prev = 0
  for (let n = 0; n < out.length; n++) {
    const t = n / SR
    const white = rnd() * 2 - 1
    const hp = white - prev // 一阶差分当高通，去掉闷的部分
    prev = white
    const click = hp * Math.exp(-t / (light ? 0.0012 : 0.002)) * (light ? 0.6 : 0.8)
    const thump = light ? 0 : Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t / 0.012) * 0.5
    out[n] = click + thump
  }
  return out
}

/**
 * 调音：两个略微失谐的音从拍频明显逐渐收敛到同音，对应"校准"。
 * 失谐量按缓动从 detuneFrom 降到 0，在时长的 85% 处完全对齐。
 */
function tuningDrone({ seconds, freq, detuneFrom }) {
  const out = new Float64Array(Math.round(seconds * SR))
  let ph1 = 0, ph2 = 0
  const easeInOut = (x) => { const t = Math.max(0, Math.min(1, x)); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }
  for (let n = 0; n < out.length; n++) {
    const t = n / SR
    const detune = detuneFrom * (1 - easeInOut(t / (seconds * 0.85)))
    ph1 += (2 * Math.PI * freq) / SR
    ph2 += (2 * Math.PI * freq * (1 + detune)) / SR
    const voice = (ph) => Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph)
    const env = Math.min(1, t / 0.8) * Math.min(1, (seconds - t) / 1.0)
    out[n] = (voice(ph1) + voice(ph2)) * 0.5 * env
  }
  return out
}

function synth(ev, k) {
  switch (ev.type) {
    case 'pluck': {
      const muted = !!ev.muted
      return pluckString({
        freq: ev.freq,
        seconds: Math.min(8, (ev.t60 ?? (muted ? 0.35 : 3.2)) * 1.4 + 0.3),
        t60: ev.t60 ?? (muted ? 0.35 : 3.2),
        brightness: muted ? 0.25 : 0.55,
        seed: 1000 + k,
      })
    }
    case 'impact': return impactBody(1.2)
    case 'click': return keyClick(!!ev.light, 5000 + k)
    case 'drone': return tuningDrone({ seconds: ev.end - ev.t, freq: ev.freq, detuneFrom: ev.detuneFrom })
    default: throw new Error(`未知音频事件类型：${ev.type}`)
  }
}

/**
 * 通用混音：事件按 bus 分组，各总线独立混响；gates 在指定时刻把某条总线（含混响尾巴）一刀切断。
 * 最后整体做片尾淡出并归一化到峰值 -1 dBFS。
 */
export function renderEvents({ duration, events, gates = [], fadeOutFrom }) {
  const total = Math.round(duration * SR)
  const buses = new Map()
  const busOf = (name) => {
    if (!buses.has(name)) buses.set(name, { L: new Float64Array(total), R: new Float64Array(total) })
    return buses.get(name)
  }
  busOf('main')
  events.forEach((ev, k) => {
    if (!Number.isFinite(ev.t) || !Number.isFinite(ev.amp)) throw new Error(`音频事件非法：${JSON.stringify(ev)}`)
    if (ev.type === 'pluck' && !Number.isFinite(ev.freq)) throw new Error(`拨弦缺少频率：${JSON.stringify(ev)}`)
    const b = busOf(ev.bus || 'main')
    mixInto(b.L, b.R, synth(ev, k), ev.t, ev.amp, ev.pan ?? 0)
  })

  const L = new Float64Array(total)
  const R = new Float64Array(total)
  let offset = 0
  for (const [name, b] of buses) {
    const wetL = reverb(b.L, offset)
    const wetR = reverb(b.R, offset + 23)
    offset += 7
    const gate = gates.find((g) => g.bus === name)
    const cut = gate ? Math.round(gate.t * SR) : Infinity
    const ramp = Math.round(0.012 * SR)
    for (let i = 0; i < total; i++) {
      const g = i < cut - ramp ? 1 : i >= cut ? 0 : (cut - i) / ramp
      if (g === 0) continue
      L[i] += (b.L[i] + wetL[i] * 0.9) * g
      R[i] += (b.R[i] + wetR[i] * 0.9) * g
    }
  }
  for (const g of gates) if (!buses.has(g.bus)) throw new Error(`门限指向不存在的总线：${g.bus}`)

  const fadeFrom = Math.round(fadeOutFrom * SR)
  let peak = 0
  for (let i = 0; i < total; i++) {
    const fade = i < fadeFrom ? 1 : 0.5 * (1 + Math.cos(Math.PI * (i - fadeFrom) / (total - fadeFrom)))
    L[i] *= fade
    R[i] *= fade
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
  }
  if (peak === 0) throw new Error('音频全静音，事件表可能为空')
  const target = Math.pow(10, -1 / 20) // 峰值 -1 dBFS
  for (let i = 0; i < total; i++) { L[i] *= target / peak; R[i] *= target / peak }
  return toWav(L, R, 7)
}

/** 6 秒样片：拨弦事件 + 证据落点的闷响。 */
export function renderAudio(tl) {
  const events = [
    { type: 'impact', t: tl.impact.t, amp: 0.35, pan: -0.6 },
    ...tl.audio.map((ev) => ({ type: 'pluck', ...ev })),
  ]
  return renderEvents({ duration: tl.DURATION, events, fadeOutFrom: tl.fadeOutFrom })
}
