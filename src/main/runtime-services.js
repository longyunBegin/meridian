import { homedir } from 'node:os'
import { join } from 'node:path'

function initialDataDirectory() {
  if (process.env.MERIDIAN_USER_DATA_DIR) return process.env.MERIDIAN_USER_DATA_DIR
  if (process.env.MERIDIAN_DATA_DIR) return process.env.MERIDIAN_DATA_DIR
  if (process.env.MERIDIAN_TEST_DATA) return process.env.MERIDIAN_TEST_DATA
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), '脉络')
}

const services = {
  dataDirectory: initialDataDirectory(),
  emitEvent: () => {},
}

/** Configure host services before loading the ledger or registering domain commands. */
export function configurePlatformServices(next = {}) {
  if (next.dataDirectory !== undefined) {
    if (typeof next.dataDirectory !== 'string' || !next.dataDirectory) {
      throw new TypeError('dataDirectory must be a non-empty path')
    }
    services.dataDirectory = next.dataDirectory
  }
  if (next.emitEvent !== undefined) {
    if (typeof next.emitEvent !== 'function') throw new TypeError('emitEvent must be a function')
    services.emitEvent = next.emitEvent
  }
}

export function dataDirectory() {
  return services.dataDirectory
}

export function emitPlatformEvent(name, payload) {
  services.emitEvent(name, payload)
}
