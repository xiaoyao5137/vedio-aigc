import test from 'node:test'
import assert from 'node:assert/strict'
import { isPublicInternetUrl, retrieveInternetSources } from '../server/web-sources.ts'

test('internet retrieval fetches source pages at runtime and returns traceable citations', async () => {
  const visited: string[] = []
  const result = await retrieveInternetSources({
    query: '张角 符水 后汉书 卷七十一 皇甫嵩朱儁列传',
    urls: ['https://archive.example.org/hou-han-shu/71'],
    maxPassages: 2,
  }, async (url) => {
    visited.push(String(url))
    return new Response('<html><head><title>后汉书卷七十一</title></head><body><article><p>钜鹿张角自称大贤良师，符水咒说以疗病，百姓信向之。</p><p>遂置三十六方，各立渠帅。</p></article></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  })
  assert.equal(result.sourceMode, 'internet')
  assert.equal(result.count, 1)
  assert.equal(result.citations[0].retrieval, 'internet')
  assert.equal(result.citations[0].url, 'https://archive.example.org/hou-han-shu/71')
  assert.match(result.text, /来源：https:\/\/archive\.example\.org/)
  assert(visited.includes('https://archive.example.org/hou-han-shu/71'))
})

test('internet retrieval uses the MediaWiki API to find and fetch the cited volume', async () => {
  const visited: string[] = []
  const result = await retrieveInternetSources({
    query: '符水与饥民',
    sourceDetail: '卷七十一《皇甫嵩朱儁列传》',
    sourceNames: ['后汉书'],
    urls: ['https://zh.wikisource.org/zh-hans/%E5%BE%8C%E6%BC%A2%E6%9B%B8'],
    maxSources: 1,
    maxPassages: 1,
  }, async (value) => {
    const url = new URL(String(value))
    visited.push(url.toString())
    if (url.searchParams.get('list') === 'search') {
      return Response.json({ query: { search: [{ title: '後漢書/卷71' }] } })
    }
    if (url.searchParams.get('action') === 'parse') {
      return Response.json({ parse: { displaytitle: '後漢書/卷71', text: { '*': '<div><p>初，鉅鹿張角自稱大賢良師，符水呪說以療病，病者頗愈，百姓信向之，於是弟子轉相教化天下。</p></div>' } } })
    }
    return new Response('not found', { status: 404 })
  })
  assert.equal(result.count, 1)
  assert.match(result.citations[0].title, /後漢書/)
  assert.match(result.citations[0].content, /張角/)
  assert(visited.some((url) => url.includes('list=search')))
  assert(visited.some((url) => url.includes('action=parse')))
})

test('internet retrieval retries an aborted source request and keeps a usable direct result', async () => {
  let directAttempts = 0
  const result = await retrieveInternetSources({
    query: '符水与饥民 后汉书 卷七十一《皇甫嵩朱儁列传》',
    urls: [
      'https://ctext.org/hou-han-shu/huang-fu-song-zhu-jun-lie-zhuan/zhs',
      'https://zh.wikisource.org/zh-hans/%E8%B3%87%E6%B2%BB%E9%80%9A%E9%91%91',
    ],
    maxPassages: 1,
  }, async (value) => {
    const url = new URL(String(value))
    if (url.hostname === 'ctext.org') {
      directAttempts += 1
      if (directAttempts === 1) throw new DOMException('This operation was aborted', 'AbortError')
      return new Response('<html><head><title>後漢書·皇甫嵩朱雋列傳</title></head><body><p>鉅鹿張角自稱大賢良師，符水呪說以療病，百姓信向之，弟子轉相教化天下。</p></body></html>')
    }
    return Response.json({ query: { search: [] } })
  })
  assert.equal(directAttempts, 2)
  assert.equal(result.count, 1)
  assert.match(result.citations[0].content, /張角/)
})

test('internet retrieval gives connection resets more retries without consulting the fallback after recovery', async () => {
  let directAttempts = 0
  let wikiAttempts = 0
  const result = await retrieveInternetSources({
    query: '后汉书 张角',
    urls: ['https://ctext.org/hou-han-shu', 'https://zh.wikisource.org/wiki/後漢書'],
    maxPassages: 1,
  }, async (value) => {
    const url = new URL(String(value))
    if (url.hostname.endsWith('wikisource.org')) {
      wikiAttempts += 1
      throw new Error('fallback should not run')
    }
    directAttempts += 1
    if (directAttempts < 3) {
      const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      throw new TypeError('fetch failed', { cause })
    }
    return new Response('<html><head><title>後漢書</title></head><body><p>鉅鹿張角自称大贤良师，符水咒说以疗病，病者颇愈，百姓信向之，于是弟子转相教化天下。</p></body></html>')
  })
  assert.equal(directAttempts, 3)
  assert.equal(wikiAttempts, 0)
  assert.equal(result.count, 1)
})

test('internet retrieval retries transient connect failures and exposes the nested network cause', async () => {
  let directAttempts = 0
  await assert.rejects(() => retrieveInternetSources({
    query: '后汉书 张角',
    urls: ['https://archive.example.org/hou-han-shu'],
    timeoutMs: 1_000,
  }, async (value) => {
    if (new URL(String(value)).hostname === 'archive.example.org') directAttempts += 1
    const cause = Object.assign(new Error(`Connect Timeout Error (attempted address: ${new URL(String(value)).hostname}:443)`), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    })
    throw new TypeError('fetch failed', { cause })
  }), /连接超时（已尝试 2 次，UND_ERR_CONNECT_TIMEOUT）/)
  assert.equal(directAttempts, 2)
})

test('internet retrieval decomposes the workflow query and falls back to a focused MediaWiki hit', async () => {
  const searches: string[] = []
  const directUrl = 'https://ctext.org/hou-han-shu/huang-fu-song-zhu-jun-lie-zhuan/zhs'
  const result = await retrieveInternetSources({
    query: '符水与饥民 后汉书 卷八《孝灵帝纪》、卷七十一《皇甫嵩朱儁列传》；《三国志》卷一《武帝纪》、卷三十二《先主传》；《资治通鉴》卷五十八 同一时段《资治通鉴》相关卷次',
    urls: [directUrl, 'https://zh.wikisource.org/zh-hans/%E8%B3%87%E6%B2%BB%E9%80%9A%E9%91%91'],
    maxSources: 1,
    maxPassages: 1,
  }, async (value) => {
    const url = new URL(String(value))
    if (url.hostname === 'ctext.org') throw new DOMException('This operation was aborted', 'AbortError')
    if (url.searchParams.get('list') === 'search') {
      const search = url.searchParams.get('srsearch') ?? ''
      searches.push(search)
      return Response.json({ query: { search: search === '后汉书 卷七十一 皇甫嵩朱儁列传' ? [{ title: '後漢書/卷71' }] : [] } })
    }
    if (url.searchParams.get('action') === 'parse') {
      return Response.json({ parse: { displaytitle: '後漢書/卷71', text: { '*': '<p>初，鉅鹿張角自稱大賢良師，符水呪說以療病，病者頗愈，百姓信向之，弟子轉相教化天下。</p>' } } })
    }
    return new Response('not found', { status: 404 })
  })
  assert(searches.includes('后汉书 卷七十一 皇甫嵩朱儁列传'))
  assert.equal(result.count, 1)
  assert.match(result.citations[0].title, /後漢書/)
  assert.deepEqual(result.failures, [{ url: directUrl, error: '抓取超时（单次 15000ms，已重试 1 次）' }])
})

test('internet retrieval only accepts public web addresses', () => {
  assert.equal(isPublicInternetUrl('https://zh.wikisource.org/wiki/%E5%BE%8C%E6%BC%A2%E6%9B%B8'), true)
  assert.equal(isPublicInternetUrl('http://127.0.0.1:5432/internal'), false)
  assert.equal(isPublicInternetUrl('file:///etc/passwd'), false)
})
