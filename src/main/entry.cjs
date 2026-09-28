const fs = require('fs')
const os = require('os')
const path = require('path')
// 只在启动链失败时写诊断日志；正常启动不写，避免 tmpdir 日志无上限增长。
const logFail = (msg) => {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'meridian-entry-debug.log'), new Date().toISOString() + ' ' + msg + '\n')
  } catch {}
}

const e = require('electron')

globalThis.__electron = e
// 打包后 main.js 在 app.asar 内，相对路径 import 会卡死；用 fileURL 显式定位
const { pathToFileURL } = require('url')
const mainUrl = pathToFileURL(path.join(__dirname, 'main.js')).href
import(mainUrl).catch(err => {
  logFail('import main.js FAILED: ' + (err && err.stack || err && err.message))
})
