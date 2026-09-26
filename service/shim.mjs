/** Electron 替身（service 版）。让 src/main/* 的业务模块在纯 Node 下可用，
 * 与 test/electron-stub.mjs 是同一 pattern，只是面向服务而不是测试。
 *
 * 用法（在任何业务模块 import 之前执行）：
 *   import './shim.mjs'
 *
 * 注意：本文件只设置 globalThis.__electron，绝不碰业务逻辑。
 */

import { EventEmitter } from 'node:events'

/** channel → handler。service 按 channel 取出调用，形态与 ipcMain.handle('ch', (_, ...args) => …) 一致。 */
export const __handlers = new Map()

export const ipcMain = {
  /** Electron 里同一个 channel 只能 handle 一次；这里直接覆盖登记，方便重启 reload。 */
  handle: (ch, fn) => { __handlers.set(ch, fn) },
  /** ipcMain.on(channel, listener) 的 listener 形态是 (event, ...args)，第一个参数 event 被忽略。 */
  on: (ch, fn) => { __handlers.set(ch, (event = {}, ...args) => fn(event, ...args)) },
  removeHandler: () => {},
  /** 本地调试用：直接触发已注册的 handler。 */
  emit: (ch, ...args) => {
    const fn = __handlers.get(ch)
    if (!fn) throw new Error(`没有注册的 channel: ${ch}`)
    return fn({}, ...args)
  },
}

export const app = {
  /** service 不像 Electron 一样能推导 userData 目录：显式 env 优先，默认与桌面 App 同一位置。 */
  getPath: (name) => {
    if (name === 'userData') return process.env.MERIDIAN_DATA_DIR || '/home/hatch/.config/脉络'
    throw new Error(`service 替身不支持的 app.getPath('${name}')`)
  },
  whenReady: () => Promise.resolve(),
  isPackaged: true,
  on: () => {},
  quit: () => {},
  exit: () => {},
  setPath: () => {},
}

export const shell = {
  openPath: async () => '',
  openExternal: async () => {},
}

export const clipboard = {
  readText: () => '',
  writeText: () => {},
}

export const BrowserWindow = class extends EventEmitter {
  constructor() { super(); this.webContents = { send: () => {}, once: () => {}, on: () => {} } }
  loadFile() { return Promise.resolve() }
  on() { return this }
  once() { return this }
  show() {}
}
export const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) }
export const globalShortcut = { register: () => true, unregisterAll: () => {} }

globalThis.__electron = { ipcMain, app, shell, clipboard, BrowserWindow, screen, globalShortcut }
