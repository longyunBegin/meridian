/**
 * 设计系统回归护栏（UI 重构期间新增）
 *
 * 背景：把字面量收敛到令牌时，脚本很容易把"定义行"一起替换掉，产生 `--x: var(--x)`
 * 这种自引用——CSS 会把它算成"保证无效"，于是整条颜色/间距在某片作用域里静默失效。
 * 这种错误不会让任何 DOM 断言失败，只能靠真机看颜色，所以把它固化成测试。
 *
 * 运行：node test/design-system.test.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CSS_FILES = ['design-system.css', 'styles.css', 'demo-components.css', 'demo-theme.css', 'ledger.css']
  .map((name) => join(ROOT, 'src/renderer', name))

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  condition ? passed++ : failed++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? `  ${detail}` : ''}`)
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')

/** 把暗色作用域整块抹成空白（长度不变，索引不漂移），这样"写死值覆盖"只看浅色层。 */
const blankDarkScopes = (text) => {
  const chars = text.split('')
  const header = /@media[^{]*prefers-color-scheme:\s*dark[^{]*\{|\.rdr-root\s*\{|\[[^\]]*dark[^\]]*\]\s*\{/g
  let match = header.exec(text)
  while (match) {
    let index = match.index + match[0].length - 1
    let depth = 0
    for (; index < text.length; index++) {
      if (text[index] === '{') depth += 1
      else if (text[index] === '}') {
        depth -= 1
        if (depth === 0) { index += 1; break }
      }
    }
    for (let i = match.index; i < index; i++) chars[i] = ' '
    header.lastIndex = index
    match = header.exec(text)
  }
  return chars.join('')
}

const sources = CSS_FILES.map((path) => ({ path, raw: readFileSync(path, 'utf8') }))
  .map((file) => {
    const text = stripComments(file.raw)
    return { path: file.path, text, lightOnly: blankDarkScopes(text) }
  })
const designSystem = sources.find((file) => file.path.endsWith('design-system.css')).text
const shortName = (path) => path.split('/').pop()

/* 1) 不允许自定义属性自引用：--x: var(--x) 会让该变量在整片作用域里失效 */
const selfRefs = []
for (const { path, text } of sources) {
  const re = /--([a-zA-Z0-9-]+)\s*:\s*var\(--\1\)/g
  let match = re.exec(text)
  while (match) {
    selfRefs.push(`${shortName(path)}:${text.slice(0, match.index).split('\n').length}`)
    match = re.exec(text)
  }
}
check('没有任何自定义属性自引用（--x: var(--x)）', selfRefs.length === 0, selfRefs.slice(0, 3).join(' | '))

/* 2) 基础令牌必须在设计系统里定义（唯一真相） */
const REQUIRED = [
  '--accent', '--accent-strong', '--red', '--orange', '--green', '--purple',
  '--t-caption', '--t-footnote', '--t-body', '--t-title', '--t-title1',
  '--sp-1', '--sp-4', '--sp-6', '--r-sm', '--r', '--r-lg',
  '--e-1', '--e-2', '--dur-1', '--dur-2', '--ease-out', '--focus-ring', '--material-thin',
]
const missing = REQUIRED.filter((token) => !new RegExp(`${token}\\s*:`).test(designSystem))
check('设计系统定义了全部基础令牌', missing.length === 0, missing.join(', '))

/* 3) 语义色不应被其他样式表在浅色层写死覆盖（暗色覆盖合法） */
const overridden = []
for (const { path, lightOnly } of sources) {
  if (path.endsWith('design-system.css')) continue
  for (const token of ['--accent', '--green', '--red', '--orange']) {
    const re = new RegExp(`${token}\\s*:\\s*#`, 'g')
    let match = re.exec(lightOnly)
    while (match) {
      overridden.push(`${shortName(path)} ${token}`)
      match = re.exec(lightOnly)
    }
  }
}
check('语义色没有被其他样式表在浅色层写死覆盖', overridden.length === 0, overridden.slice(0, 4).join(', '))

/* 4) 字号必须走令牌：只允许图/矩阵/合成轴内部那几个有意为之的字面量 */
const ALLOWED_LITERAL_CONTEXT = /--t-network|cog-|rdr-axis|rdr-matrix/
const literalSizes = []
for (const { path, text } of sources) {
  for (const match of text.matchAll(/([^\n{]*)\{[^}]*font-size:\s*[0-9.]+(?:px|rem)/g)) {
    const selector = match[1].split(/[}\n]/).pop().trim()
    if (ALLOWED_LITERAL_CONTEXT.test(selector)) continue
    literalSizes.push(`${shortName(path)} ${selector.slice(0, 40)}`)
  }
}
check('字号一律走令牌（图内部白名单除外）', literalSizes.length === 0, literalSizes.slice(0, 3).join(' | '))

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
