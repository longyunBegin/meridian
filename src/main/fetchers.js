/**
 * 取数器注册表。
 *
 * channels.fetch 字段已存在但从未被读取用于分发——本模块补上这层。
 * 归一后的形状直接喂 processCapture()，不加新流水线。
 *
 * 来源类型由取数器给定（channel.kind），不走 labelSource() 猜。
 * labeler.js 看到 channelMeta.kind 会直接用，不调模型。
 */

import { fetchFeed } from './feeds.js'
import { fetchUrl } from './fetcher.js'

const FETCHERS = {
  rss: async (channel) => {
    const items = await fetchFeed(channel.query)
    return items.map((item) => ({
      title: item.title,
      text: item.description || item.title,
      url: item.link || '',
      platform: null,
      publishedAt: item.pubDate || null,
      kind: channel.kind,
    }))
  },

  web: async (channel) => {
    const text = await fetchUrl(channel.query)
    if (!text || text.length < 50) return []
    return [{
      title: channel.name,
      text,
      url: channel.query,
      platform: null,
      publishedAt: null,
      kind: channel.kind,
    }]
  },

  // 以下未实现，静默返回空
  tavily: null,
  'grok-x-search': null,
  jina: null,
  edgarConcept: null,
  edgarFilings: null,
  cninfo: null,
  eastmoneyReport: null,
  manual: null,
}

/**
 * 按通道的 fetch 类型分发到对应取数器。
 * 未实现的类型静默返回空数组，不抛错、不卡流水线。
 */
export async function fetchChannel(channel) {
  const fn = FETCHERS[channel.fetch]
  if (!fn) return []
  try {
    return await fn(channel)
  } catch {
    return []
  }
}

/** 列出所有已注册的 fetch 类型（供 UI 显示哪些可用） */
export function availableFetchers() {
  return Object.keys(FETCHERS).filter((k) => FETCHERS[k] != null)
}