/** 把 'electron' 指到 test/electron-stub.mjs，让主进程模块能在 Node 下跑。 */
export function resolve(specifier, context, next) {
  if (specifier === 'electron') {
    return { url: new URL('./electron-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
