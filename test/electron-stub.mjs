/** electron 的测试替身。只实现主进程用到的那几个面。 */
import { EventEmitter } from 'node:events'

/** channel → handler。测试直接按 channel 取出来调用，和 Electron 的调用形态一致。 */
export const __handlers = new Map()

export const ipcMain = {
  handle: (ch, fn) => __handlers.set(ch, fn),
  on: (ch, fn) => __handlers.set(ch, fn),
  removeHandler: () => {},
  emit: (ch, ...args) => {
    const fn = __handlers.get(ch)
    if (!fn) throw new Error(`没有注册的 channel: ${ch}`)
    return fn({}, ...args)
  },
}

export const app = {
  getPath: () => process.env.MERIDIAN_TEST_DATA || '/tmp/meridian-ipc-test',
  whenReady: () => Promise.resolve(),
  isPackaged: false,
  on: () => {},
  quit: () => {},
  exit: () => {},
  setPath: () => {},
}

export const shell = { openPath: () => Promise.resolve('') }
export const BrowserWindow = class extends EventEmitter {
  constructor() { super(); this.webContents = { send: () => {}, once: () => {}, on: () => {} } }
  loadFile() { return Promise.resolve() }
  on() { return this }
  once() { return this }
  show() {}
}
export const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) }
export const clipboard = { readText: () => '' }
export const globalShortcut = { register: () => true, unregisterAll: () => {} }
