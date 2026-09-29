/**
 * 逐帧渲染：Electron 加载 pluck.html，每帧由页面自己把 canvas 导出为 PNG，经管道交给 ffmpeg。
 * 不依赖屏幕合成器，也不需要屏幕录制权限；同一台机器上重复运行输出一致。
 *
 * 运行：
 *   electron tools/film/render.mjs --timeline <json> --out <mp4>          完整视频（无音轨）
 *   electron tools/film/render.mjs --timeline <json> --stills 1.2,2.3 --dir <目录>   只出静帧
 * 可选：
 *   --page film.html          渲染页面（默认 pluck.html）
 *   --from 0 --to 900         只渲染帧区间 [from, to)，供并行分段
 */
import { app, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1]
}

/** 读取 PNG IHDR 中的宽高，用来断言输出尺寸。 */
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 数据')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

function startEncoder(out, fps) {
  const ff = spawn('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))))
  })
  const write = (buf) => new Promise((resolve, reject) => {
    ff.stdin.write(buf, (err) => (err ? reject(err) : resolve()))
  })
  const end = () => { ff.stdin.end(); return done }
  return { write, end }
}

async function main() {
  const timelinePath = arg('timeline')
  if (!timelinePath) throw new Error('缺少 --timeline')
  const tl = JSON.parse(readFileSync(timelinePath, 'utf8'))

  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 540,
    webPreferences: { backgroundThrottling: false, contextIsolation: true },
  })
  const page = arg('page') || 'pluck.html'
  if (!/^[\w-]+\.html$/.test(page)) throw new Error(`页面名非法：${page}`)
  await win.loadFile(join(HERE, page))
  const wc = win.webContents
  const size = await wc.executeJavaScript(`window.__init(${JSON.stringify(tl)})`)
  if (size.w !== tl.W || size.h !== tl.H) throw new Error(`画布尺寸 ${size.w}×${size.h} 与时间轴 ${tl.W}×${tl.H} 不符`)

  const frameAt = async (i) => {
    const buf = Buffer.from(await wc.executeJavaScript(`window.__frame(${i})`), 'base64')
    const { w, h } = pngSize(buf)
    if (w !== tl.W || h !== tl.H) throw new Error(`第 ${i} 帧尺寸 ${w}×${h} 不符`)
    return buf
  }

  const stills = arg('stills')
  if (stills) {
    const dir = arg('dir') || join(HERE, '../../test/.tmp/film/stills')
    mkdirSync(dir, { recursive: true })
    for (const s of stills.split(',').map(Number)) {
      if (!Number.isFinite(s) || s < 0 || s > tl.DURATION) throw new Error(`静帧时间非法：${s}`)
      const file = join(dir, `t${s.toFixed(2)}.png`)
      writeFileSync(file, await frameAt(Math.round(s * tl.FPS)))
      console.log('→', file)
    }
    return
  }

  const out = arg('out')
  if (!out) throw new Error('缺少 --out 或 --stills')
  mkdirSync(dirname(out), { recursive: true })
  const total = Math.round(tl.DURATION * tl.FPS)
  const from = arg('from') === null ? 0 : Number(arg('from'))
  const to = arg('to') === null ? total : Number(arg('to'))
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > total || from >= to) {
    throw new Error(`帧区间非法：[${from}, ${to})，总帧数 ${total}`)
  }
  const enc = startEncoder(out, tl.FPS)
  const t0 = Date.now()
  for (let i = from; i < to; i++) {
    await enc.write(await frameAt(i))
    if ((i - from) % (tl.FPS * 5) === 0) console.log(`  [${from}-${to}) 帧 ${i}`)
  }
  await enc.end()
  console.log(`→ ${out}（${to - from} 帧，${((Date.now() - t0) / 1000).toFixed(1)}s）`)
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => { console.error(err); app.exit(1) })
