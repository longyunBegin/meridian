/**
 * 成片总装：引擎算数 → 时间轴 → 合成声音 → 多进程并行逐帧渲染 → 拼接 → 混流 → 校验。
 *
 * 运行：
 *   node tools/film/film.mjs                        出完整 60 秒成片
 *   node tools/film/film.mjs --stills 3,8,12.3      只出静帧，快速检查画面
 *   node tools/film/film.mjs --workers 4            指定并行进程数
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runChain, runCalibration } from './chain.mjs'
import { buildFilm } from './film-timeline.mjs'
import { renderEvents } from './audio.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT_DIR = join(ROOT, 'test/.tmp/film')
const SEG_DIR = join(OUT_DIR, 'segments')
const ELECTRON = join(ROOT, 'node_modules/.bin/electron')
const RENDER = join(ROOT, 'tools/film/render.mjs')
const LOGO_SRC = join(ROOT, 'assets/icons-src/meridian-logo-bw-luxe.webp')

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1]
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`)
}

function runAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`))))
  })
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'format=duration:stream=codec_type,nb_read_frames,width,height,r_frame_rate,sample_rate,channels', '-of', 'json', file], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffprobe 失败：${r.stderr}`)
  return JSON.parse(r.stdout)
}

mkdirSync(OUT_DIR, { recursive: true })

const logoPng = join(OUT_DIR, 'logo-800.png')
run('ffmpeg', ['-v', 'error', '-y', '-i', LOGO_SRC, '-vf', 'scale=800:800', logoPng])
const logo = 'data:image/png;base64,' + readFileSync(logoPng).toString('base64')

const chain = await runChain()
const calib = await runCalibration()
const film = buildFilm(chain, calib, { logo })
const tlPath = join(OUT_DIR, 'film-timeline.json')
writeFileSync(tlPath, JSON.stringify(film))

const stills = arg('stills')
if (stills) {
  run(ELECTRON, [RENDER, '--page', 'film.html', '--timeline', tlPath, '--stills', stills, '--dir', join(OUT_DIR, 'film-stills')])
  process.exit(0)
}

const wav = join(OUT_DIR, 'film.wav')
writeFileSync(wav, renderEvents({ duration: film.DURATION, events: film.audio, gates: film.gates, fadeOutFrom: film.fadeOutFrom }))
console.log('→', wav)

const total = Math.round(film.DURATION * film.FPS)
const workers = Math.max(1, Math.min(Number(arg('workers')) || Math.floor(cpus().length / 2), 8))
rmSync(SEG_DIR, { recursive: true, force: true })
mkdirSync(SEG_DIR, { recursive: true })
const per = Math.ceil(total / workers)
const segs = []
for (let w = 0; w < workers; w++) {
  const from = w * per
  const to = Math.min(total, from + per)
  if (from >= to) break
  segs.push({ from, to, file: join(SEG_DIR, `seg-${String(w).padStart(2, '0')}.mp4`) })
}
console.log(`并行渲染 ${total} 帧，${segs.length} 个进程`)
const t0 = Date.now()
await Promise.all(segs.map((s) => runAsync(ELECTRON, [RENDER, '--page', 'film.html', '--timeline', tlPath,
  '--from', String(s.from), '--to', String(s.to), '--out', s.file])))
console.log(`渲染完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const list = join(SEG_DIR, 'list.txt')
writeFileSync(list, segs.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`).join('\n') + '\n')
const silent = join(OUT_DIR, 'film.video.mp4')
run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent])

const final = join(OUT_DIR, 'meridian-film.mp4')
run('ffmpeg', ['-v', 'error', '-y', '-i', silent, '-i', wav,
  '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
  '-t', String(film.DURATION), '-movflags', '+faststart', final])

const poster = join(OUT_DIR, 'meridian-film-poster.jpg')
run('ffmpeg', ['-v', 'error', '-y', '-ss', '58.5', '-i', final, '-frames:v', '1', '-q:v', '2', poster])

const info = probe(final)
const v = info.streams.find((s) => s.codec_type === 'video')
const a = info.streams.find((s) => s.codec_type === 'audio')
const frames = Number(v.nb_read_frames)
const dur = Number(info.format.duration)
if (frames !== total) throw new Error(`成片帧数 ${frames}，应为 ${total}`)
if (Math.abs(dur - film.DURATION) > 0.05) throw new Error(`成片时长 ${dur}，应为 ${film.DURATION}`)
if (v.width !== film.W || v.height !== film.H) throw new Error(`成片尺寸 ${v.width}×${v.height}`)
if (!a || Number(a.sample_rate) !== 48000 || a.channels !== 2) throw new Error('音轨缺失或参数不符')
console.log(`→ ${final}（${v.width}×${v.height} · ${v.r_frame_rate} · ${frames} 帧 · ${dur.toFixed(2)}s · 立体声）`)
console.log('→', poster)
