import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_BODY = 1024 * 1024
const VERSIONS = ['2025-03-26', '2025-06-18']
const pushSchema = {
  type: 'object', required: ['schema', 'readings'], additionalProperties: false,
  properties: {
    schema: { const: 'meridian.reading.v1' }, at: { type: 'string' }, themeHint: { type: 'string' },
    readings: { type: 'array', minItems: 1, maxItems: 1000, items: {
      type: 'object', required: ['indicator', 'value', 'unit', 'period', 'source'],
      properties: {
        indicator: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string' },
        period: { type: 'object', required: ['start', 'end'], properties: { start: { type: 'string' }, end: { type: 'string' } } },
        basis: { enum: ['reported', 'estimated'] }, tier: { enum: ['structured', 'local-llm', 'agent'] },
        source: { type: 'object', required: ['label', 'url'], properties: {
          kind: { type: 'string' }, label: { type: 'string' }, url: { type: 'string' }, platform: { type: 'string' }, accn: { type: 'string' },
        } }, raw: { type: 'string' },
      },
    } },
  },
}
const tools = [
  { name: 'push_readings', description: '推送读数，经过验证后入账；返回逐条拒收原因。', inputSchema: pushSchema },
  { name: 'list_themes', description: '读取主题、环节树和标签库，不含任何密钥。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_open_judgments', description: '读取未结算判断与正在等待的指标。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
]

export async function startAgentServer({ userData, ingest, getIntent, onChanged = () => {}, host = '127.0.0.1', port = 0, requireToken = true }) {
  // 凭据可关闭，但只对本机绑定开放——绑到局域网还免鉴权，等于把账本敞开在网络上
  const token = requireToken ? randomBytes(32).toString('hex') : ''
  const exposed = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
  if (exposed && !requireToken) throw new Error('绑定非本机地址必须启用访问凭据')
  const discoveryFile = join(userData, 'agent-port.json')
  const stats = { accepted: 0, rejected: 0, oversized: 0 }
  let closed = false
  let pending = 0
  let queue = Promise.resolve()

  const submit = (body) => {
    if (pending >= 8) return Promise.reject(Object.assign(new Error('摄入队列已满，请稍后重试'), { status: 429 }))
    pending++
    const result = queue.then(async () => {
      const result = await ingest(body)
      stats.accepted += result.accepted || 0
      stats.rejected += result.rejected?.length || 0
      if (result.accepted) onChanged()
      return result
    })
    queue = result.catch(() => {}).finally(() => { pending-- })
    return result
  }
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(body == null ? '' : JSON.stringify(body))
  }
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const authorized = (req) => {
    if (!token) return true
    const received = Buffer.from(req.headers.authorization || '')
    const expected = Buffer.from(`Bearer ${token}`)
    return received.length === expected.length && timingSafeEqual(received, expected)
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      let oversized = Number(req.headers['content-length']) > MAX_BODY
      const chunks = []
      req.on('data', (chunk) => {
        if (oversized) return
        size += chunk.length
        if (size > MAX_BODY) {
          oversized = true
          chunks.length = 0
        } else chunks.push(chunk)
      })
      req.on('end', () => {
        if (oversized) { reject(Object.assign(new Error('内容超过 1MB'), { status: 413 })); return }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(Object.assign(new Error('无效 JSON'), { status: 400 })) }
      })
      req.on('error', reject)
      req.on('aborted', () => reject(Object.assign(new Error('请求已中断'), { status: 400 })))
    })
  }
  async function handleRpc(msg, res) {
    if (!msg || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string'
      || (msg.id !== undefined && typeof msg.id !== 'string' && typeof msg.id !== 'number')) {
      return send(res, 200, rpcError(null, -32600, '无效请求'))
    }
    const id = msg.id
    if (id === undefined) return send(res, 202, null)
    let result
    if (msg.method === 'initialize') {
      const params = msg.params
      if (!params || typeof params !== 'object' || Array.isArray(params) || typeof params.protocolVersion !== 'string'
        || !params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities)
        || typeof params.clientInfo?.name !== 'string' || typeof params.clientInfo?.version !== 'string') {
        return send(res, 200, rpcError(id, -32602, '初始化参数不完整'))
      }
      const version = params.protocolVersion
      result = { protocolVersion: VERSIONS.includes(version) ? version : VERSIONS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'meridian', version: '0.8.0' } }
    } else if (msg.method === 'ping') result = {}
    else if (msg.method === 'tools/list') result = { tools }
    else if (msg.method === 'tools/call') {
      const { name, arguments: args = {} } = msg.params || {}
      if (!args || typeof args !== 'object' || Array.isArray(args)) return send(res, 200, rpcError(id, -32602, '无效参数'))
      let data
      if (name === 'push_readings') {
        try { data = await submit(args) }
        catch (e) { data = { ok: false, error: e.status === 429 ? e.message : '摄入失败，请稍后重试' } }
      } else if (name === 'list_themes' || name === 'list_open_judgments') {
        if (Object.keys(args).length) return send(res, 200, rpcError(id, -32602, '此工具不接受参数'))
        const intent = await getIntent()
        data = name === 'list_themes' ? intent.themes : intent.openJudgments
      } else return send(res, 200, rpcError(id, -32602, '未知工具'))
      result = { content: [{ type: 'text', text: JSON.stringify(data) }], isError: data?.ok === false }
    } else return send(res, 200, rpcError(id, -32601, '未知方法'))
    send(res, 200, { jsonrpc: '2.0', id, result })
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.origin) return send(res, 403, { ok: false, error: '不接受浏览器跨站请求' })
      if (req.headers.host !== `127.0.0.1:${server.address().port}` && req.headers.host !== `localhost:${server.address().port}`) return send(res, 403, { ok: false, error: '无效主机' })
      if (!authorized(req)) return send(res, 401, { ok: false, error: '需要本地访问凭据' })
      const path = req.url?.split('?')[0]
      if (path === '/intent' && req.method === 'GET') return send(res, 200, await getIntent())
      if (path !== '/readings' && path !== '/mcp') return send(res, 404, { ok: false, error: '不存在的入口' })
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, 405, { ok: false, error: '请使用 POST' }) }
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { ok: false, error: '请发送 JSON' })
      const version = req.headers['mcp-protocol-version']
      if (path === '/mcp' && version && !VERSIONS.includes(version)) return send(res, 400, { ok: false, error: '不支持的协议版本' })
      const body = await readBody(req)
      if (path === '/mcp') return await handleRpc(body, res)
      const result = await submit(body)
      send(res, result.ok === false && !result.accepted ? 422 : 200, result)
    } catch (e) {
      if (e.status === 413) stats.oversized++
      if (!res.headersSent && !res.destroyed) {
        if (req.url?.split('?')[0] === '/mcp' && e.status === 400) send(res, 400, rpcError(null, -32700, '无效 JSON'))
        else send(res, e.status || 500, { ok: false, error: e.status ? e.message : '摄入失败，请检查本地记录' })
      }
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.maxConnections = 16
  // 地址和端口都由设置决定。曾经写死 127.0.0.1 + 随机端口——
  // agent 在别的机器上根本连不到，端口每次启动还变，agent 没法配固定地址。
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(port) || 0, host, resolve)
  })
  const boundPort = server.address().port
  const discovery = { host, port: boundPort, token, requireToken: !!token, protocol: 'meridian.reading.v1' }
  try {
    const temp = `${discoveryFile}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(discovery), { mode: 0o600 })
    await rename(temp, discoveryFile)
  } catch (e) { await new Promise((r) => server.close(r)); throw e }

  return {
    ...discovery, stats,
    async close() {
      closed = true
      await queue
      await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections() })
      try {
        const current = JSON.parse(await readFile(discoveryFile, 'utf8'))
        if (current.token === token) await unlink(discoveryFile)
      } catch {}
    },
  }
}
