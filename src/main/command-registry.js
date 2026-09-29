/** Transport-neutral registry for domain operations exposed by an application host. */
export class CommandRegistry {
  #commands = new Map()
  #onSuccess

  constructor({ onSuccess = null } = {}) {
    if (onSuccess !== null && typeof onSuccess !== 'function') {
      throw new TypeError('onSuccess must be a function')
    }
    this.#onSuccess = onSuccess
  }

  register(name, handler) {
    if (typeof name !== 'string' || !name) throw new TypeError('command name is required')
    if (typeof handler !== 'function') throw new TypeError(`handler for ${name} must be a function`)
    if (this.#commands.has(name)) throw new Error(`command already registered: ${name}`)
    this.#commands.set(name, handler)
    return this
  }

  has(name) {
    return this.#commands.has(name)
  }

  names() {
    return [...this.#commands.keys()]
  }

  invoke(name, args = []) {
    const complete = (result) => {
      if (!this.#onSuccess) return result
      const hook = this.#onSuccess(name, args, result)
      return hook && typeof hook.then === 'function' ? hook.then(() => result) : result
    }
    const result = this.invokeWithoutHooks(name, args)
    return result && typeof result.then === 'function' ? result.then(complete) : complete(result)
  }

  /**
   * Invoke a command without the onSuccess hook (no outbox recording).
   * Used by the Mac sync endpoint (/sync/ops) to apply VM-produced ops locally:
   * the op originated on the VM, so recording it into the Mac outbox would loop.
   */
  invokeWithoutHooks(name, args = []) {
    if (!Array.isArray(args)) throw new TypeError('command arguments must be an array')
    const handler = this.#commands.get(name)
    if (!handler) throw new Error(`unknown command: ${name}`)
    return handler(...args)
  }
}
