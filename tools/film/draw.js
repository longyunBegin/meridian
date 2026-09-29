/*
 * 共享绘图：银弦、珍珠节点、波前光点、证据卡、字幕、背景与颗粒。
 * 样片（pluck.html）与成片（film.html）共用。所有函数只由参数和时间 t 决定，无内部状态。
 * 以经典脚本加载，导出到 window.Draw。
 */
(() => {
  const SANS = '"PingFang SC", "SF Pro Display", "Helvetica Neue", sans-serif'
  const NUM = '"SF Pro Display", "Helvetica Neue", sans-serif'
  const MONO = '"SF Mono", Menlo, monospace'
  const BLUE = [10, 132, 255]

  const clamp01 = (x) => Math.max(0, Math.min(1, x))
  const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t) }
  const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3)
  const easeIn = (x) => { const t = clamp01(x); return t * t }
  const easeInOut = (x) => { const t = clamp01(x); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`
  const lerp = (a, b, k) => a + (b - a) * k

  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function buildGrain(seed) {
    const rnd = mulberry32(seed)
    const out = []
    for (let k = 0; k < 4; k++) {
      const g = document.createElement('canvas')
      g.width = 480; g.height = 270
      const gx = g.getContext('2d')
      const img = gx.createImageData(g.width, g.height)
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.floor(rnd() * 255)
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v
        img.data[i + 3] = 255
      }
      gx.putImageData(img, 0, 0)
      out.push(g)
    }
    return out
  }

  async function loadFonts() {
    await document.fonts.load(`500 30px ${SANS}`)
    await document.fonts.load(`300 34px ${NUM}`)
    await document.fonts.load(`400 20px ${MONO}`)
    await document.fonts.ready
  }

  function background(ctx, W, H) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    const vg = ctx.createRadialGradient(W / 2, H * 0.46, 120, W / 2, H * 0.46, W * 0.62)
    vg.addColorStop(0, 'rgba(28,30,36,1)')
    vg.addColorStop(1, 'rgba(0,0,0,1)')
    ctx.fillStyle = vg
    ctx.fillRect(0, 0, W, H)
  }

  function grainAndFade(ctx, grain, frame, W, H, fade) {
    ctx.globalAlpha = 0.045
    ctx.globalCompositeOperation = 'screen'
    ctx.drawImage(grain[frame % grain.length], 0, 0, W, H)
    ctx.globalCompositeOperation = 'source-over'
    if (fade < 1) {
      ctx.globalAlpha = 1 - fade
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
    }
    ctx.globalAlpha = 1
  }

  /**
   * 画一根银弦。heat∈[0,1] 是振动强度；blue=false 时强度只提亮不染蓝（噪音不配用强调色）。
   */
  function silver(ctx, pts, { heat = 0, alpha = 1, blue = true, core = 1.8 } = {}) {
    if (pts.length < 2 || alpha <= 0.001) return
    const path = () => {
      ctx.beginPath()
      ctx.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
    }
    const a = pts[0], b = pts[pts.length - 1]
    ctx.save()
    ctx.globalAlpha *= alpha
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    path(); ctx.strokeStyle = 'rgba(210,216,226,0.07)'; ctx.lineWidth = core * 4; ctx.stroke()
    if (heat > 0.01 && blue) { path(); ctx.strokeStyle = rgba(BLUE, 0.28 * heat); ctx.lineWidth = core * 5.5; ctx.stroke() }
    const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1])
    g.addColorStop(0, 'rgba(236,239,244,0.85)')
    g.addColorStop(0.5, 'rgba(170,176,186,0.75)')
    g.addColorStop(1, 'rgba(236,239,244,0.85)')
    path(); ctx.strokeStyle = g; ctx.lineWidth = core; ctx.stroke()
    if (heat > 0.01) {
      path()
      ctx.strokeStyle = blue ? rgba([150, 200, 255], 0.7 * heat) : `rgba(255,255,255,${0.6 * heat})`
      ctx.lineWidth = core * 0.8
      ctx.stroke()
    }
    ctx.restore()
  }

  function glowDot(ctx, x, y, radius, alpha, color = BLUE) {
    if (alpha <= 0.001) return
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius)
    g.addColorStop(0, rgba([190, 225, 255], alpha))
    g.addColorStop(0.25, rgba(color, 0.6 * alpha))
    g.addColorStop(1, rgba(color, 0))
    ctx.fillStyle = g
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  }

  function pearl(ctx, x, y, r, dimK = 0) {
    const mix = (a, b) => {
      const ca = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
      const cb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
      return `rgb(${ca.map((v, i) => Math.round(v + (cb[i] - v) * dimK)).join(',')})`
    }
    const pg = ctx.createRadialGradient(x - r * 0.32, y - r * 0.36, r * 0.09, x, y, r)
    pg.addColorStop(0, mix('#ffffff', '#c9ccd2'))
    pg.addColorStop(0.45, mix('#d9dce2', '#8d9199'))
    pg.addColorStop(1, mix('#6e737c', '#3b3e44'))
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = pg
    ctx.fill()
  }

  // ------------------------------------------------------------------ 传导树

  const nodeOf = (tl, key) => tl.nodes.find((n) => n.key === key)

  /** 一条边在时刻 t、位置 s∈[0,1] 的横向位移（像素）。 */
  function displacement(tl, e, s, t) {
    if (e.t0 === null) return 0
    const dt = t - e.t0
    if (dt <= 0) return 0
    const A = Math.abs(e.raw) * tl.PX_PER_POINT * Math.sign(e.raw || 1)
    const p = dt / tl.HOP
    if (e.cut) {
      // 振动走到半路自己熄灭：对应引擎里取整为 0、不再往下传。
      const life = 1 - smooth(0, 0.55, p)
      return -A * Math.exp(-Math.pow((s - p) / 0.07, 2)) * life
    }
    const bump = p <= 1.15 ? Math.exp(-Math.pow((s - p) / 0.07, 2)) : 0
    const passed = smooth(p - 0.12, p, s)
    const ringing = s <= p ? 1 : 1 - passed
    const env = Math.exp(-dt / 0.9)
    const f = 5.2 + (e.weight || 0.5) * 2
    const standing = 0.8 * Math.sin(Math.PI * s) * Math.sin(2 * Math.PI * f * dt) * env * clamp01(ringing)
    return -A * (bump * (1 - 0.35 * clamp01(p)) + standing)
  }

  /**
   * opt.grow∈[0,1]：边从上游长出的比例；opt.alpha：整体透明度；
   * opt.weightAlpha：权重标注透明度；opt.weightFlash∈[0,1]：权重标注被点亮的程度。
   */
  function edge(ctx, tl, e, t, opt = {}) {
    const { grow = 1, alpha = 1, weightAlpha = 1, weightFlash = 0 } = opt
    if (grow <= 0 || alpha <= 0.001) return
    const a = nodeOf(tl, e.from)
    const b = nodeOf(tl, e.to)
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    const nx = -dy / len, ny = dx / len
    const N = 96
    const pts = []
    let peak = 0
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * grow
      const d = displacement(tl, e, s, t)
      peak = Math.max(peak, Math.abs(d))
      pts.push([a.x + dx * s + nx * d, a.y + dy * s + ny * d])
    }
    ctx.save()
    ctx.globalAlpha *= alpha
    silver(ctx, pts, { heat: clamp01(peak / 30) })

    if (e.t0 !== null && grow >= 1) {
      const p = (t - e.t0) / tl.HOP
      const end = e.cut ? 0.6 : 1
      if (p > 0 && p < end) {
        const rawMax = Math.max(...tl.edges.map((x) => Math.abs(x.raw)))
        const strength = Math.sqrt(Math.abs(e.raw) / rawMax)
        const life = e.cut ? 1 - smooth(0.05, end, p) : 1 - smooth(0.85, 1, p)
        const [sx, sy] = pts[Math.round(p * N)]
        glowDot(ctx, sx, sy, 26, life * (0.35 + 0.65 * strength))
      }
    }

    if (weightAlpha > 0.001) {
      ctx.font = `${weightFlash > 0.01 ? 500 : 400} 20px ${MONO}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const c = [Math.round(lerp(142, BLUE[0], weightFlash)), Math.round(lerp(142, BLUE[1], weightFlash)), Math.round(lerp(147, BLUE[2], weightFlash))]
      ctx.fillStyle = rgba(c, 0.85 * weightAlpha)
      ctx.fillText('×' + e.weight, a.x + dx / 2 + nx * 34, a.y + dy / 2 + ny * 34)
    }
    ctx.restore()
  }

  /**
   * opt.alpha：整体；opt.pop：珍珠缩放（出场弹跳用）；opt.titleAlpha / opt.numberAlpha：文字出场。
   */
  function node(ctx, tl, n, t, opt = {}) {
    const { alpha = 1, pop = 1, titleAlpha = 1, numberAlpha = 1 } = opt
    if (alpha <= 0.001) return
    ctx.save()
    ctx.globalAlpha *= alpha
    const hit = n.reachT !== null && t >= n.reachT
    const since = hit ? t - n.reachT : 0
    const origin = nodeOf(tl, tl.origin)
    const strength = n.reachT !== null ? Math.abs(n.delta) / Math.abs(origin.delta) : 0

    if (hit) {
      const ring = easeOut(since / 0.7)
      ctx.beginPath()
      ctx.arc(n.x, n.y, 12 + ring * (26 + 34 * strength), 0, Math.PI * 2)
      ctx.strokeStyle = rgba(BLUE, (1 - ring) * (0.35 + 0.5 * strength))
      ctx.lineWidth = 2
      ctx.stroke()
      const glow = Math.exp(-since / 1.2) * (0.25 + 0.6 * strength)
      const gg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 70)
      gg.addColorStop(0, rgba(BLUE, 0.55 * glow))
      gg.addColorStop(1, rgba(BLUE, 0))
      ctx.fillStyle = gg
      ctx.fillRect(n.x - 70, n.y - 70, 140, 140)
    }

    // 未被传导到的节点：在振动熄灭时逐渐变暗，之前与其他节点一样
    const cutEdge = n.reachT === null ? tl.edges.find((e) => e.to === n.key && e.cut) : null
    const dimK = cutEdge ? smooth(cutEdge.t0 + tl.HOP * 0.4, cutEdge.t0 + tl.HOP * 0.9, t) : 0
    if (pop > 0.001) pearl(ctx, n.x, n.y, 11 * pop, dimK)

    const right = n.side === 'right'
    const tx = right ? n.x + 30 : n.x
    ctx.textAlign = right ? 'left' : 'center'
    ctx.textBaseline = 'alphabetic'
    if (titleAlpha > 0.001) {
      ctx.font = `500 30px ${SANS}`
      ctx.fillStyle = `rgba(245,245,247,${(0.94 - 0.52 * dimK) * titleAlpha})`
      ctx.fillText(n.title, tx, right ? n.y + 10 : n.y - 40)
    }
    if (numberAlpha > 0.001) {
      const roll = hit ? easeOut(since / 0.45) : 0
      const v = Math.round(n.before + (n.after - n.before) * roll)
      ctx.font = `300 40px ${NUM}`
      ctx.fillStyle = `rgba(245,245,247,${(0.9 - 0.5 * dimK) * numberAlpha})`
      ctx.fillText(String(v), tx, right ? n.y + 60 : n.y + 62)

      if (hit && n.delta !== 0) {
        const numW = ctx.measureText(String(n.after)).width
        const a = smooth(0, 0.3, since)
        const settle = smooth(1.4, 2.4, since) * 0.5 // 变化量从强调蓝退到半灰
        const col = [
          Math.round(lerp(BLUE[0], 142, settle)),
          Math.round(lerp(BLUE[1], 142, settle)),
          Math.round(lerp(BLUE[2], 147, settle)),
        ]
        const label = (n.delta > 0 ? '+' : '') + n.delta
        ctx.font = `500 24px ${NUM}`
        ctx.fillStyle = rgba(col, a * numberAlpha)
        if (right) ctx.fillText(label, tx + numW + 16, n.y + 58)
        else ctx.fillText(label, n.x, n.y + 98 - 6 * (1 - a))
      }
      if (cutEdge) {
        const a = smooth(cutEdge.t0 + tl.HOP * 0.6, cutEdge.t0 + tl.HOP * 1.1, t)
        ctx.font = `400 22px ${SANS}`
        ctx.fillStyle = `rgba(142,142,147,${0.9 * a * numberAlpha})`
        ctx.fillText('不再传导', n.x, n.y + 98)
      }
    }
    ctx.restore()
  }

  function evidence(ctx, tl, t, alpha = 1) {
    const o = nodeOf(tl, tl.origin)
    const ev = tl.evidence
    const show = alpha * smooth(ev.showT, ev.showT + 0.35, t) * (1 - 0.6 * smooth(tl.T_IMPACT + 0.2, tl.T_IMPACT + 0.9, t))
    if (show > 0.001) {
      ctx.save()
      ctx.font = `400 24px ${SANS}`
      const tw = ctx.measureText(ev.text).width
      const w = tw + 76, h = 58
      const x = o.x - 40, y = o.y - 250
      ctx.globalAlpha = show
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, 14)
      ctx.fillStyle = 'rgba(38,38,40,0.9)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(x + 30, y + h / 2, 6, 0, Math.PI * 2)
      ctx.fillStyle = rgba(BLUE, 1)
      ctx.fill()
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(245,245,247,0.92)'
      ctx.fillText(ev.text, x + 50, y + h / 2 + 1)
      ctx.restore()
    }
    if (alpha > 0.001 && t >= ev.dropT && t < tl.T_IMPACT) {
      const k = easeIn((t - ev.dropT) / (tl.T_IMPACT - ev.dropT))
      const y0 = o.y - 190, y1 = o.y - 12
      const y = y0 + (y1 - y0) * k
      for (let i = 0; i < 6; i++) {
        ctx.beginPath()
        ctx.arc(o.x, y - i * 10 * k, 6 - i * 0.8, 0, Math.PI * 2)
        ctx.fillStyle = rgba(BLUE, (0.9 - i * 0.14) * alpha)
        ctx.fill()
      }
    }
  }

  function chrome(ctx, theme, alpha) {
    if (alpha <= 0.001) return
    ctx.save()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.font = `500 20px ${SANS}`
    ctx.fillStyle = `rgba(245,245,247,${0.55 * alpha})`
    ctx.fillText(`主题 · ${theme}`, 96, 110)
    ctx.font = `400 18px ${SANS}`
    ctx.fillStyle = `rgba(142,142,147,${0.55 * alpha})`
    ctx.fillText('上游  →  下游', 96, 140)
    ctx.restore()
  }

  function subtitles(ctx, subs, t, W, H) {
    for (const s of subs) {
      const a = smooth(s.from, s.from + 0.3, t) * (1 - smooth(s.to - 0.3, s.to, t))
      if (a <= 0.001) continue
      ctx.save()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      // system-ui 优先：苹方的 ⇧ ⌘ 字形在字幕字号下会糊成"介"，系统字体的键帽符号才清楚
      ctx.font = `400 38px system-ui, ${SANS}`
      ctx.fillStyle = `rgba(245,245,247,${0.92 * a})`
      ctx.fillText(s.text, W / 2, H - 92 + 8 * (1 - a))
      ctx.restore()
    }
  }

  window.Draw = {
    SANS, NUM, MONO, BLUE,
    clamp01, smooth, easeOut, easeIn, easeInOut, rgba, lerp, mulberry32,
    buildGrain, loadFonts, background, grainAndFade,
    silver, glowDot, pearl, displacement, edge, node, evidence, chrome, subtitles,
  }
})()
