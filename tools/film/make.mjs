/**
 * 样片总装：引擎算数 → 时间轴 → 合成声音 → 逐帧渲染 → 混流。
 *
 * 运行：
 *   node tools/film/make.mjs                    出完整样片
 *   node tools/film/make.mjs --stills 1.3,2.4   只出静帧，快速检查画面
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runChain } from './chain.mjs'
import { buildTimeline } from './timeline.mjs'
import { renderAudio } from './audio.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT_DIR = join(ROOT, 'test/.tmp/film')
const ELECTRON = join(ROOT, 'node_modules/.bin/electron')
const RENDER = join(ROOT, 'tools/film/render.mjs')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`)
}

mkdirSync(OUT_DIR, { recursive: true })
const chain = await runChain()
const tl = buildTimeline(chain)
const tlPath = join(OUT_DIR, 'timeline.json')
writeFileSync(tlPath, JSON.stringify(tl, null, 2))

const si = process.argv.indexOf('--stills')
if (si !== -1) {
  run(ELECTRON, [RENDER, '--timeline', tlPath, '--stills', process.argv[si + 1], '--dir', join(OUT_DIR, 'stills')])
  process.exit(0)
}

const wav = join(OUT_DIR, 'pluck.wav')
writeFileSync(wav, renderAudio(tl))
console.log('→', wav)

const silent = join(OUT_DIR, 'pluck.video.mp4')
run(ELECTRON, [RENDER, '--timeline', tlPath, '--out', silent])

const final = join(OUT_DIR, 'meridian-pluck-sample.mp4')
run('ffmpeg', [
  '-v', 'error', '-y', '-i', silent, '-i', wav,
  '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
  '-t', String(tl.DURATION), '-movflags', '+faststart', final,
])
console.log('→', final)
