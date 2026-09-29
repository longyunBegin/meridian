import { CommandRegistry } from '../src/main/command-registry.js'
import { configurePlatformServices } from '../src/main/runtime-services.js'
import { OUTBOX_CHANNELS, recordOutbox } from '../src/main/sync-outbox.js'

export function createCommandTestHarness(dataDirectory, { outbox = false, emitEvent = () => {} } = {}) {
  configurePlatformServices({ dataDirectory, emitEvent })
  const registry = new CommandRegistry({
    onSuccess: outbox
      ? (name, args) => { if (OUTBOX_CHANNELS.has(name)) recordOutbox(name, args, dataDirectory) }
      : null,
  })
  return { registry, invoke: (name, ...args) => registry.invoke(name, args) }
}
