const fs = require('fs')
const os = require('os')
const path = require('path')
const log = (msg) => {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'meridian-entry-debug.log'), msg + '\n')
  } catch {}
}
log('entry.cjs started')
log('process.type: ' + process.type)
log('process.versions.electron: ' + process.versions.electron)

const e = require('electron')
log('require(electron) type: ' + typeof e)
log('require(electron) keys: ' + (typeof e === 'object' ? Object.keys(e).slice(0,10).join(',') : 'N/A'))
log('app type: ' + typeof e.app)

globalThis.__electron = e
log('globalThis.__electron set, importing main.js')
// 打包后 main.js 在 app.asar 内，相对路径 import 会卡死；用 fileURL 显式定位
const { pathToFileURL } = require('url')
const mainUrl = pathToFileURL(path.join(__dirname, 'main.js')).href
log('main.js url: ' + mainUrl)
import(mainUrl).catch(err => {
  log('import main.js FAILED: ' + (err && err.message))
})
