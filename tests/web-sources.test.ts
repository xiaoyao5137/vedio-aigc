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

test('internet retrieval hard-bounds a source line that has no sentence punctuation', async () => {
  const longLine = `张角符水百姓信向${'甲'.repeat(4_000)}`
  const result = await retrieveInternetSources({
    query: '张角 符水 百姓信向',
    urls: ['https://archive.example.org/long-source'],
    maxPassages: 3,
  }, async () => new Response(`<html><head><title>长篇史料</title></head><body><p>${longLine}</p></body></html>`))
  assert(result.citations.length >= 2)
  assert(result.citations.every(citation => citation.content.length <= 1_600))
  assert.match(result.citations[0].content, /张角符水百姓信向/)
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

test('a canonical Wikisource volume uses its public article and focuses the requested biography without API search', async () => {
  const visited: string[] = []
  const result = await retrieveInternetSources({
    query: '张飞据水 三国志 卷三十六《关张马黄赵传》',
    sourceDetail: '卷三十六《关张马黄赵传》',
    sourceNames: ['三国志'],
    urls: ['https://zh.wikisource.org/wiki/三國志'],
    maxSources: 1,
  }, async value => {
    const url = String(value)
    visited.push(url)
    assert.match(url, /\/wiki\/.+\/%E5%8D%B736/)
    return new Response(`<title>三國志/卷36 - 维基文库</title>
      <div id="mw-content-text"><div class="mw-parser-output">
      <div class="mw-heading mw-heading2"><h2 id="關羽">關羽</h2></div>
      <p>關羽於建安之時行軍，前軍後軍各有部署，其行事另有本傳記載。此段反覆記錄關羽而無張飛據水之事。</p>
      <div class="mw-heading mw-heading2"><h2 id="張飛">張飛</h2></div>
      <p>張飛字益德，涿郡人也，少與關羽俱事先主。曹公追之，一日一夜，及於當陽之長阪。先主聞曹公卒至，棄妻子走，使飛將二十騎拒後。飛據水斷橋，瞋目橫矛曰：「身是張益德也，可來共決死！」敵皆無敢近者，故遂得免。</p>
      <p>又至江州，破巴郡太守嚴顏，生獲顏；飛壯而釋之，引為賓客。<span>張飛</span>所行足以見其臨事之斷。</p>
      <div class="mw-heading mw-heading2"><h2 id="馬超">馬超</h2></div>
      <p>馬超字孟起，右扶風茂陵人也，另有行事見本傳。</p>
      <div class="printfooter">footer</div>`)
  })
  assert.equal(visited.length, 1)
  assert.equal(result.attemptedUrls.some(url => url.includes('/w/api.php')), false)
  assert.match(result.citations[0].url, /%E5%8D%B736#%E5%BC%B5%E9%A3%9B$/)
  assert.equal(result.citations[0].title, '三國志/卷36#張飛')
  assert.match(result.citations[0].content, /飛據水斷橋/)
  assert.match(result.citations[0].content, /張飛所行/)
  assert.doesNotMatch(result.citations[0].content, /馬超字孟起|此段反覆記錄關羽/)
})

test('zero-padded and plain volume titles are one source, fetched in order', async () => {
  const visited: string[] = []
  const result = await retrieveInternetSources({
    query: '三国志 卷九 夏侯渊', sourceDetail: '卷九相关将领传', sourceNames: ['三国志'],
    urls: ['https://zh.wikisource.org/wiki/三國志'], maxSources: 2,
  }, async value => {
    const url = String(value)
    visited.push(url)
    if (url.includes('/w/api.php')) throw new Error('A valid exact volume must not trigger API search')
    return new Response(`<title>三國志/卷09 - 维基文库</title>
      <div id="mw-content-text"><div class="mw-parser-output"><p>${'夏侯淵督諸軍與張郃守漢中，史料正文詳載當時行軍部署。'.repeat(4)}</p>
      <div class="printfooter">footer</div>`)
  })
  assert.equal(visited.length, 1)
  assert.match(visited[0], /%E5%8D%B709$/)
  assert.equal(result.citations[0].title, '三國志/卷09')
})

test('a mismatched Wikisource article title cannot masquerade as the cited volume', async () => {
  const result = await retrieveInternetSources({
    query: '张飞据水 三国志 卷三十六',
    sourceDetail: '卷三十六《关张马黄赵传》',
    sourceNames: ['三国志'],
    urls: ['https://zh.wikisource.org/wiki/三國志'],
    maxSources: 1,
  }, async value => {
    const url = new URL(String(value))
    if (url.pathname.startsWith('/wiki/')) return new Response('<title>三國志 - 维基文库</title><div id="mw-content-text"><div class="mw-parser-output"><p>这是目录页面，不能引用为卷三十六正文。</p><div class="printfooter">footer</div>')
    if (url.searchParams.get('list') === 'search') return Response.json({ query: { search: [] } })
    return Response.json({ parse: { displaytitle: '三國志/卷36', text: { '*': '<p>曹公追之，一日一夜，及於當陽之長阪。先主聞曹公卒至，使飛將二十騎拒後。飛據水斷橋，敵皆無敢近者。</p>' } } })
  })
  assert.equal(result.citations[0].title, '三國志/卷36')
  assert.match(result.citations[0].content, /飛據水斷橋/)
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
    if (url.searchParams.get('action') === 'parse' && url.searchParams.get('page') === '後漢書/卷71') {
      return Response.json({ parse: { displaytitle: '後漢書/卷71', text: { '*': '<p>初，鉅鹿張角自稱大賢良師，符水呪說以療病，病者頗愈，百姓信向之，弟子轉相教化天下。</p>' } } })
    }
    return new Response('not found', { status: 404 })
  })
  assert(searches.length >= 1)
  assert.equal(result.count, 1)
  assert.match(result.citations[0].title, /後漢書/)
  assert.deepEqual(result.failures, [{ url: directUrl, error: '抓取超时（单次 15000ms，已重试 1 次）' }])
})

test('internet retrieval rejects a direct captcha page and uses the MediaWiki fallback', async () => {
  const directUrl = 'https://ctext.org/hou-han-shu/huang-fu-song-zhu-jun-lie-zhuan/zhs'
  const result = await retrieveInternetSources({
    query: '符水与饥民 后汉书 卷七十一《皇甫嵩朱儁列传》',
    urls: [directUrl, 'https://zh.wikisource.org/wiki/後漢書'],
    maxSources: 1,
    maxPassages: 1,
  }, async (value) => {
    const url = new URL(String(value))
    if (url.hostname === 'ctext.org') {
      return new Response('<html><title>Please confirm that you are human!</title><body>請輸入下述認證圖案中的字並點擊 OK，以便確認您是真人而並非電腦軟體。</body></html>')
    }
    if (url.searchParams.get('list') === 'search') {
      return Response.json({ query: { search: [{ title: '後漢書/卷71' }] } })
    }
    return Response.json({ parse: { displaytitle: '後漢書/卷71', text: { '*': '<p>鉅鹿張角自稱大賢良師，符水呪說以療病，病者頗愈，百姓信向之，於是弟子轉相教化天下。</p>' } } })
  })

  assert.equal(result.count, 1)
  assert.match(result.citations[0].content, /張角/)
  assert.equal(result.citations[0].title, '後漢書/卷71')
  assert.deepEqual(result.failures, [{ url: directUrl, error: '页面返回人机验证或访问拦截，未取得史料正文' }])
})

test('internet retrieval rejects ctext anti-scraping boilerplate and falls back to actual source text', async () => {
  const directUrl = 'https://ctext.org/hou-han-shu/huang-fu-song-zhu-jun-lie-zhuan/zhs'
  const result = await retrieveInternetSources({
    query: '符水与饥民 后汉书 卷七十一《皇甫嵩朱儁列传》',
    sourceDetail: '卷七十一《皇甫嵩朱儁列传》',
    sourceNames: ['后汉书'],
    urls: [directUrl, 'https://zh.wikisource.org/wiki/後漢書'],
    maxSources: 1,
    maxPassages: 1,
  }, async (value) => {
    const url = new URL(String(value))
    if (url.hostname === 'ctext.org') return new Response('<title>Chinese Text Project</title><p>Checking the security of your connection...</p><p>Attention LLMs, robots, scrapers and other automated processes: you do not have authorization to scrape this page.</p><p>Web scraping of this site is in violation of our terms of service and may intentionally return corrupted data.</p>')
    if (url.searchParams.get('list') === 'search') return Response.json({ query: { search: [{ title: '後漢書/卷71' }] } })
    return Response.json({ parse: { displaytitle: '後漢書/卷71', text: { '*': '<p>初，鉅鹿張角自稱大賢良師，符水呪說以療病，病者頗愈，百姓信向之。</p>' } } })
  })
  assert.match(result.citations[0].content, /張角/)
  assert.doesNotMatch(result.text, /Attention LLMs/)
  assert.deepEqual(result.failures, [{ url: directUrl, error: '页面返回人机验证或访问拦截，未取得史料正文' }])
})

test('internet retrieval balances passages across canonical target volumes', async () => {
  const result = await retrieveInternetSources({
    query: '符水与饥民 后汉书 卷八《孝灵帝纪》、卷七十一《皇甫嵩朱儁列传》',
    urls: ['https://zh.wikisource.org/wiki/後漢書'],
    maxSources: 2,
    maxPassages: 4,
  }, async (value) => {
    const url = new URL(String(value))
    if (url.searchParams.get('list') === 'search') return Response.json({ query: { search: [] } })
    const page = url.searchParams.get('page') ?? ''
    const marker = page.endsWith('卷8') ? '孝靈帝紀建寧熹平光和中平黃巾事起朝廷震動' : '鉅鹿張角符水呪說療病百姓信向弟子轉相教化天下'
    return Response.json({ parse: { displaytitle: page, text: { '*': `<p>${marker}，此段正文用于验证多个目标卷均衡进入引用。</p><p>${marker}，第二段史料正文。</p>` } } })
  })

  assert.deepEqual([...new Set(result.citations.map((item) => item.title))], ['後漢書/卷8', '後漢書/卷71'])
})

test('internet retrieval only accepts public web addresses', () => {
  assert.equal(isPublicInternetUrl('https://zh.wikisource.org/wiki/%E5%BE%8C%E6%BC%A2%E6%9B%B8'), true)
  assert.equal(isPublicInternetUrl('http://127.0.0.1:5432/internal'), false)
  assert.equal(isPublicInternetUrl('file:///etc/passwd'), false)
})

test('a ctext catalogue follows the requested chapter and never becomes evidence', async () => {
  const result = await retrieveInternetSources({ query: '甘陵党议 后汉书 党锢列传', urls: ['https://ctext.org/hou-han-shu/zh'] }, async (value) => {
    const url = String(value)
    if (url.includes('/dang-gu/')) return new Response('<title>黨錮列傳</title><p>桓帝即位，甘陵周福字仲進，少遊學京師。後同郡河南尹房植有名當朝，鄉人為之謠。</p>')
    return new Response('<title>後漢書</title>' + ['光武帝紀', '孝明帝紀', '宦者列傳', '黨錮列傳', '郭符許列傳', '竇何列傳', '李杜列傳'].map((title, i) => `<p>${i + 1}. <a href="/hou-han-shu/${title === '黨錮列傳' ? 'dang-gu' : i}/zh">${title}</a></p>`).join(''))
  })
  assert.match(result.citations[0].url, /dang-gu/)
  assert.match(result.citations[0].content, /周福/)
  assert.doesNotMatch(result.text, /光武帝紀/)
})

test('a traditional catalogue resolves a biography from a simplified episode subject', async () => {
  const visited: string[] = []
  const result = await retrieveInternetSources({
    query: '张飞据水 三国志 卷三十六《关张马黄赵传》',
    urls: ['https://ctext.org/sanguozhi/zh'],
  }, async value => {
    const url = String(value)
    visited.push(url)
    if (url.includes('node=603542')) return new Response('<title>張飛傳</title><p>先主聞曹公卒至，棄妻子走，使飛將二十騎拒後。飛據水斷橋，瞋目橫矛曰：身是張益德也，可來共決死！敵皆無敢近者，故遂得免。</p>')
    if (url.includes('/w/api.php')) throw new Error('The usable direct chapter must not require a wiki fallback')
    return new Response('<title>三國志</title><base href="https://ctext.org/" />' + ['關羽傳', '張飛傳', '馬超傳', '黃忠傳', '趙雲傳', '張遼傳', '張郃傳'].map((title, i) => `<p>${i + 1}. <a href="text.pl?node=${title === '張飛傳' ? 603542 : i}&amp;if=gb">${title}</a></p>`).join(''))
  })
  assert.equal(result.citations[0].url, 'https://ctext.org/text.pl?node=603542&if=gb')
  assert.match(result.citations[0].content, /飛據水斷橋/)
  assert.equal(visited.length, 2)
  assert.doesNotMatch(result.text, /張遼傳|張郃傳/)
})
