import assert from 'node:assert/strict'
import { CommandRegistry } from '../src/main/command-registry.js'

const success = []
const registry = new CommandRegistry({ onSuccess: (name, args, result) => success.push({ name, args, result }) })
registry.register('sum', (left, right) => left + right)
registry.register('async', async (value) => ({ value }))
assert.deepEqual(registry.names(), ['sum', 'async'])
assert.equal(registry.has('sum'), true)
assert.equal(registry.has('missing'), false)
assert.equal(await registry.invoke('sum', [2, 3]), 5)
assert.deepEqual(await registry.invoke('async', ['ok']), { value: 'ok' })
assert.deepEqual(success, [
  { name: 'sum', args: [2, 3], result: 5 },
  { name: 'async', args: ['ok'], result: { value: 'ok' } },
])
assert.throws(() => registry.register('sum', () => 0), /already registered/)
assert.throws(() => registry.register('bad', null), /must be a function/)
assert.throws(() => registry.invoke('missing'), /unknown command/)
assert.throws(() => registry.invoke('sum', 'not-an-array'), /must be an array/)
assert.equal(success.length, 2, 'failed commands do not trigger success hooks')
console.log('Command registry: explicit arguments, allowlisting, errors, and success middleware passed')
