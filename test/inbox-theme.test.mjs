/**
 * 收件箱条目级主题测试：inferInboxThemeId + inboxRouteValid。
 * 覆盖今日收件箱跨主题场景：条目带着自己的主题做可选性判定与分组入库。
 *
 * 运行：node test/inbox-theme.test.mjs
 */
import { inferInboxThemeId, inboxRouteValid } from '../src/renderer/views/shared.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}

// 两个主题的节点：光互连（A）与 Sivers（B）
const nodeA = { id: 'n-a1', themeId: 'theme-a', parentId: null, status: 'live' }
const nodeB = { id: 'n-b1', themeId: 'theme-b', parentId: null, status: 'live' }
const nodeADead = { id: 'n-a2', themeId: 'theme-a', parentId: null, status: 'dead' }
const allNodes = [nodeA, nodeB, nodeADead]

console.log('\n— inferInboxThemeId：条目级主题 —')
ok('新数据：extractedThemeId 优先',
  inferInboxThemeId({ extractedThemeId: 'theme-b', lemmas: [{ parentId: 'n-a1' }] }, allNodes, 'theme-a') === 'theme-b')
ok('老数据：从 parentId 挂点反推主题',
  inferInboxThemeId({ lemmas: [{ parentId: 'n-b1' }] }, allNodes, 'theme-a') === 'theme-b')
ok('老数据：合并类命题从 mergeInto 反推',
  inferInboxThemeId({ lemmas: [{ action: 'merge', mergeInto: 'n-b1' }] }, allNodes, 'theme-a') === 'theme-b')
ok('挂点都不认识时回退当前主题',
  inferInboxThemeId({ lemmas: [{ parentId: 'nope' }] }, allNodes, 'theme-a') === 'theme-a')
ok('没有命题时回退当前主题',
  inferInboxThemeId({ lemmas: [] }, allNodes, 'theme-a') === 'theme-a')

const itemB = { id: 'it-b', extracted: true, extractedThemeId: 'theme-b', lemmas: [{ title: 't', parentId: 'n-b1' }] }
const nodesB = allNodes.filter((n) => n.themeId === 'theme-b')
const nodesA = allNodes.filter((n) => n.themeId === 'theme-a')

console.log('\n— inboxRouteValid：挂点必须落在条目自己的主题 —')
ok('挂点在自己主题的存活节点 → 可选',
  inboxRouteValid(itemB, nodesB, {}) === true)
ok('挂点是别的主题的节点 → 不可选（防错主题入库）',
  inboxRouteValid(itemB, nodesA, {}) === false)
ok('挂点节点已死 → 不可选',
  inboxRouteValid({ ...itemB, lemmas: [{ title: 't', parentId: 'n-a2' }] }, allNodes.filter((n) => n.themeId === 'theme-a'), {}) === false)
ok('用户手动改到自己主题的环节 → 可选',
  inboxRouteValid(itemB, nodesB, { parentId: 'n-b1' }) === true)
ok('用户手动改到别的主题 → 仍不可选',
  inboxRouteValid(itemB, nodesA, { parentId: 'n-b1' }) === false)
ok('根级挂点（parentId 为空）→ 可选',
  inboxRouteValid({ ...itemB, lemmas: [{ title: 't', parentId: null }] }, nodesB, {}) === true)
ok('合并类命题不看挂点',
  inboxRouteValid({ ...itemB, lemmas: [{ title: 't', action: 'merge', mergeInto: 'n-b1' }] }, nodesA, {}) === true)
ok('多命题里有一条挂点越界 → 整体不可选',
  inboxRouteValid({ ...itemB, lemmas: [{ title: 't1', parentId: 'n-b1' }, { title: 't2', parentId: 'n-a1' }] }, nodesB, {}) === false)

console.log(`\n${pass} 通过, ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
