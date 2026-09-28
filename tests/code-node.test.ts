import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { executeCodeNode } from '../server/code-node.ts'
import { SANGUO_CHARACTER_LOOKUP_CODE, SANGUO_CONTEXT_INIT_CODE, SANGUO_FIRST_FRAME_BRANCH_CODE, SANGUO_REUSE_TAIL_CODE, SANGUO_TAIL_FRAME_CODE,
  refreshHistoricalMapBarePlateCode, refreshMapPortraitBackgroundCode } from '../src/code-node-presets.ts'

const workbookPath = new URL('../public/data/三国历史短剧1000集策划总表.xlsx', import.meta.url)

async function workbookUpload() {
  const buffer = await readFile(workbookPath)
  return {
    id: 'sanguo-workbook',
    name: '三国历史短剧1000集策划总表.xlsx',
    dataUrl: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${buffer.toString('base64')}`,
  }
}

test('configurable JavaScript matches episode 41 and emits an input context patch', async () => {
  const result = await executeCodeNode({
    code: SANGUO_CONTEXT_INIT_CODE,
    context: { input: { episode_number: 41 } },
    files: [await workbookUpload()],
  })
  assert.equal(result.matchedBy.rowNumber, 42)
  assert.equal(result.fields.episode_number, 41)
  assert.equal(result.fields.episode_title, '符水与饥民')
  assert.equal(result.fields.historical_period, '184')
  assert.deepEqual(result.fields.source_titles, ['后汉书'])
  assert.deepEqual(result.fields.verification_urls, [
    'https://ctext.org/hou-han-shu/huang-fu-song-zhu-jun-lie-zhuan/zhs',
    'https://zh.wikisource.org/zh-hans/%E8%B3%87%E6%B2%BB%E9%80%9A%E9%91%91',
  ])
  assert.equal('scene_count' in result.fields, false)
  assert.equal('target_duration' in result.fields, false)
  assert.equal('historical_query' in result.fields, false)
  assert.match(String(result.internetRequest.query), /符水与饥民 后汉书 .*卷七十一/)
  assert.deepEqual(result.internetRequest.urls, result.fields.verification_urls)
  assert.equal(result.internetRequest.maxSources, 3)
  assert.equal(result.internetRequest.maxPassages, 6)
  assert.deepEqual(result.contextPatch, { input: { episode_number: 41, ...result.fields } })
  assert.equal(result.sheet.rowCount, 1000)
  assert.match(result.executionLogs[0], /符水与饥民/)
})

test('node code controls matching and reports a clear error for an unknown episode', async () => {
  await assert.rejects(
    executeCodeNode({
      code: SANGUO_CONTEXT_INIT_CODE,
      context: { input: { episode_number: 1001 } },
      files: [await workbookUpload()],
    }),
    /Excel 中未找到第 1001 集/,
  )
})

test('excel.parse exposes workbook metadata and bounded parsed rows to custom code', async () => {
  const result = await executeCodeNode({
    code: `
      const parsed = excel.parse(files[0], { sheetName: params.sheet, headerRow: 1, outputLimit: 2 })
      return { ...parsed, selectedEpisode: input.episode_number, note: prompt }
    `,
    prompt: '自定义解析',
    params: { sheet: '1000集总表' },
    context: { input: { episode_number: 7 } },
    files: [await workbookUpload()],
  })
  assert.equal(result.count, 1000)
  assert.equal(result.rows.length, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.selectedEpisode, 7)
  assert.equal(result.note, '自定义解析')
  assert.deepEqual(result.workbook.sheetNames, ['总览', '1000集总表', '史料索引', '使用说明'])
})

test('character lookup code preserves cached assets and marks only new cast members for generation', async () => {
  const cached = { id: 'character-zhangjiao', characterName: '张角', url: '/characters/zhangjiao.png' }
  const result = await executeCodeNode({
    code: SANGUO_CHARACTER_LOOKUP_CODE,
    context: {
      shot_script: { characters: ['张角', '张宝', '张角'], firstFramePrompt: '张宝二十余岁，头戴黄巾。' },
      character_lookup_result: {
        characters: [{ name: '张角', continuityKey: '张角-eastern-han-v1' }, { name: '张宝', continuityKey: '张宝-eastern-han-v1' }],
        items: [cached],
        missingCharacters: [{ name: '张宝', continuityKey: '张宝-eastern-han-v1' }],
      },
    },
  })
  assert.deepEqual(result.names, ['张角', '张宝'])
  assert.deepEqual(result.existingAssets, [cached])
  assert.deepEqual(result.existingImages, ['/characters/zhangjiao.png'])
  assert.deepEqual(result.existingNames, ['张角'])
  assert.deepEqual(result.missingCharacters.map((item: Record<string, unknown>) => item.name), ['张宝'])
  assert.equal(result.foundCount, 1)
  assert.equal(result.missingCount, 1)
  assert.equal(result.shouldGenerate, true)
  assert.equal(result.imageRequest.size, '1792x1024')
  assert.equal(result.imageRequest.aspectRatio, '16:9')
  assert.equal(result.imageRequest.n, 1)
  assert.deepEqual(result.imageRequest.referenceImages, [])
  assert.match(String(result.imageRequest.prompt), /张宝/)
  assert.match(String(result.imageRequest.prompt), /定妆三视图/)
  assert.match(String(result.missingCharacters[0].designPrompt), /二十余岁/)
  assert.deepEqual(result.imageRequest.requests.map((item: Record<string, unknown>) => item.n), [1])
})

test('character lookup preserves a three-view master for derived identity references', async () => {
  const result = await executeCodeNode({
    code: SANGUO_CHARACTER_LOOKUP_CODE,
    context: {
      shot_script: { characters: ['张角'] },
      character_lookup_result: {
        characters: [{ name: '张角', continuityKey: '张角-eastern-han-v1' }],
        items: [{ characterName: '张角', assetType: 'three-view', url: '/characters/zhangjiao-sheet.png' }],
        missingCharacters: [],
      },
    },
  })
  assert.deepEqual(result.existingImages, ['/characters/zhangjiao-sheet.png'])
  assert.equal(result.shouldGenerate, false)
  assert.deepEqual(result.missingCharacters, [])
})

test('character lookup derives stable appearance for entrants from the last-frame prompt', async () => {
  const result = await executeCodeNode({
    code: SANGUO_CHARACTER_LOOKUP_CODE,
    context: {
      shot_script: {
        characters: ['刘鮪', '饥民甲'],
        initialCharacters: ['刘鮪'],
        enteringCharacters: [{ name: '饥民甲', startSecond: 2, endSecond: 5, path: '画面右侧巷口' }],
        visualPrompt: '刘鮪三十余岁，面容黧黑，身穿补丁短褐。画面右侧巷口空无一人。',
        lastFramePrompt: '刘鮪站在画面中央。饥民甲四十余岁，瘦削佝偻，破旧短褐露出肋骨，站在刘鮪右前方。',
      },
      character_lookup_result: {
        characters: [{ name: '刘鮪' }, { name: '饥民甲' }],
        items: [],
        missingCharacters: [{ name: '刘鮪' }, { name: '饥民甲' }],
      },
    },
  })

  const entrant = result.missingCharacters.find((item: Record<string, unknown>) => item.name === '饥民甲')
  assert.match(String(entrant.description), /四十余岁/)
  assert.match(String(entrant.description), /瘦削佝偻/)
  assert.match(String(entrant.designPrompt), /破旧短褐/)
  assert.doesNotMatch(String(entrant.description), /刘鮪站在画面中央/)
})

test('character lookup prefers a role-only clause over a longer full-cast scene description', async () => {
  const result = await executeCodeNode({
    code: SANGUO_CHARACTER_LOOKUP_CODE,
    context: {
      shot_script: {
        characters: ['张角', '病人'],
        visualPrompt: '病人卧在草席上，张角跪在一旁，二人同处茅屋。',
        lastFramePrompt: '病人四十余岁，面色蜡黄，身形瘦削；张角三十五岁，清瘦短须，身穿褐色道袍。',
      },
      character_lookup_result: {
        characters: [{ name: '张角' }, { name: '病人' }],
        items: [],
        missingCharacters: [{ name: '病人' }],
      },
    },
  })

  const patient = result.missingCharacters[0]
  assert.match(String(patient.description), /面色蜡黄/)
  assert.doesNotMatch(String(patient.description), /张角/)
  assert.doesNotMatch(String(patient.designPrompt), /二人同处茅屋/)
})

test('character lookup strips pose, gaze, props, and background from a portrait description', async () => {
  const result = await executeCodeNode({
    code: SANGUO_CHARACTER_LOOKUP_CODE,
    context: {
      shot_script: {
        characters: ['病人'],
        visualPrompt: '中景:病人半跪草席,灰褐麻衣,瘦削脸庞仰起,喉结滚动,双眼紧闭,嘴唇闭合；背景:三五饥民贴墙静立,目光全部投向病人。',
        lastFramePrompt: '',
      },
      character_lookup_result: { characters: [{ name: '病人' }], items: [], missingCharacters: [{ name: '病人' }] },
    },
  })
  const description = String(result.missingCharacters[0].description)
  assert.match(description, /灰褐麻衣/)
  assert.match(description, /瘦削脸庞/)
  assert.doesNotMatch(description, /半跪|草席|喉结|双眼|嘴唇|背景|饥民/)
})

test('character lookup never promotes a completed chant or mouth pose into reusable identity', async () => {
  const result = await executeCodeNode({
    code: SANGUO_CHARACTER_LOOKUP_CODE,
    context: {
      shot_script: { characters: ['张角'], visualPrompt: '张角口唇微合,念咒动作刚完成' },
      character_lookup_result: {
        characters: [{ name: '张角', continuityKey: '张角-eastern-han-v2' }],
        items: [],
        missingCharacters: [{ name: '张角', continuityKey: '张角-eastern-han-v2' }],
      },
    },
  })
  assert.equal(result.missingCharacters[0].description, '')
  assert.doesNotMatch(String(result.missingCharacters[0].designPrompt), /口唇微合|动作刚完成/)
  assert.match(String(result.missingCharacters[0].designPrompt), /双臂自然下垂/)
})

test('first-frame branch routes to character references or previous-tail extraction exclusively', async () => {
  const referenced = await executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: { firstFrameMode: 'reference', firstFramePrompt: '' },
      loop: { previous: undefined },
      character_lookup: { existingImages: [] },
    },
  })
  assert.equal(referenced.shouldGenerate, false)
  assert.equal(referenced.shouldReusePreviousTail, false)
  assert.equal(referenced.route, 'reference')
  assert.deepEqual(referenced.referenceRequest.referenceImages, [])

  const reused = await executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: { firstFrameMode: 'reuse_previous_tail', firstFramePrompt: '' },
      loop: { previous: { last_frame: { url: '/frames/previous-tail.png' } } },
      character_lookup: {
        names: ['张俭', '年长党人'],
        existingAssets: [
          { characterName: '张俭', url: '/characters/zhangjian.png' },
          { characterName: '年长党人', url: '/characters/elder.png' },
        ],
      },
    },
  })
  assert.equal(reused.shouldGenerate, false)
  assert.equal(reused.shouldReusePreviousTail, true)
  assert.equal(reused.route, 'reuse_previous_tail')
  assert.deepEqual(reused.referenceRequest, {
    referenceImages: ['/characters/zhangjian.png', '/characters/elder.png'],
    referenceBindings: [{ characterName: '张俭', continuityKey: '', role: 'identity' }, { characterName: '年长党人', continuityKey: '', role: 'identity' }],
    referenceMode: 'three-view-all',
  })
  const extracted = await executeCodeNode({
    code: SANGUO_REUSE_TAIL_CODE,
    context: { first_frame_branch: { previousLastFrame: reused.previousLastFrame } },
  })
  assert.equal(extracted.url, '/frames/previous-tail.png')
  assert.equal(extracted.generated, false)
})

test('first-frame branch routes an animated map to generated boundary frames without affecting ordinary references', async () => {
  const result = await executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: { firstFrameMode: 'reference', visualTreatment: 'animated_map' },
      loop: { previous: undefined },
      character_lookup: { names: [], existingImages: [] },
    },
  })
  assert.equal(result.shouldGenerate, true)
  assert.equal(result.shouldGenerateAnimatedMapFrames, true)
  assert.equal(result.shouldGenerateAnimatedFirstFrame, true)
  assert.equal(result.shouldGenerateAnimatedEndFrame, true)
  assert.equal(result.shouldReusePreviousTail, false)
  assert.equal(result.route, 'animated_boundary_frames')
})

test('boundary-frame prompt keeps static visual identity and composition without consuming video or audio instructions', async () => {
  const shot = {
    firstFrameMode: 'reference', visualTreatment: 'animated', animationStyle: 'historical_map',
    visualPrompt: '东汉末年八州的山川、水系与城址构成历史地理底图。两支军队沿蓝红箭头撤退。',
    firstFramePrompt: '东汉末年八州的山川、水系与城址。人物肖像在左侧淡入。',
    camera: '俯视历史地图沙盘，稳定机位。',
    videoPrompt: '0-2秒：边界逐次浮现。2-5秒：画外旁白自然朗读完整原文。\n【声部与收束】保留全部历史旁白。',
    audioText: '历史旁白原文。',
    pacing: { beats: [{ kind: 'speech', textOrVocalization: '历史旁白原文。' }] },
  }
  const before = structuredClone(shot)
  const result = await executeCodeNode({ code: SANGUO_FIRST_FRAME_BRANCH_CODE, context: {
    shot_script: shot, loop: { previous: undefined }, character_lookup: { names: [], existingImages: [] },
  } })
  assert.match(result.framePrompt, /东汉末年八州的山川、水系与城址/)
  assert.match(result.framePrompt, /二维手绘古代历史地理地图|无字、无箭头、无人物/)
  assert.doesNotMatch(result.framePrompt, /俯视历史地图沙盘|两支军队沿蓝红箭头撤退|人物肖像在左侧淡入/)
  assert.deepEqual(result.frameReferenceImages, [])
  assert.doesNotMatch(result.framePrompt, /0-2秒|2-5秒|画外旁白|声部与收束|历史旁白原文/)
  assert.deepEqual(shot, before, 'approved video, audio and pacing remain exact for their own consumers')

  const tableau = await executeCodeNode({ code: SANGUO_FIRST_FRAME_BRANCH_CODE, context: {
    shot_script: { ...shot, animationStyle: 'historical_tableau', visualPrompt: '殿内两人相对而立。',
      firstFramePrompt: '张俭穿深灰交领长袍，站于门前，双手拱于胸前。' },
    loop: { previous: undefined }, character_lookup: { names: ['张俭'], existingAssets: [{ characterName: '张俭', url: '/zhangjian.png' }] },
  } })
  assert.match(tableau.framePrompt, /张俭穿深灰交领长袍|双手拱于胸前/)
  assert.doesNotMatch(tableau.framePrompt, /殿内两人|历史旁白原文|0-2秒/)
})

test('first-frame branch routes character illustration and continued animation through generic boundary frames', async () => {
  const character = await executeCodeNode({ code: SANGUO_FIRST_FRAME_BRANCH_CODE, context: {
    shot_script: { firstFrameMode: 'reference', visualTreatment: 'animated', animationStyle: 'character_illustration',
      visualPrompt: '洛阳宫城与饥困百姓。张角人物插画淡入并移至画面中心。', videoPrompt: '4-8秒：张角卡片淡入。' },
    loop: { previous: undefined }, character_lookup: { names: ['张角'], existingAssets: [{ characterName: '张角', url: '/zhangjiao.png' }] },
  } })
  assert.equal(character.isAnimatedShot, true)
  assert.equal(character.isStaticIllustration, true)
  assert.equal(character.shouldGenerateAnimatedFirstFrame, true)
  assert.equal(character.shouldGenerateAnimatedEndFrame, false)
  assert.equal(character.shouldGenerateAnimatedMapFrames, false)
  assert.equal(character.route, 'animated_boundary_frames')
  assert.deepEqual(character.frameReferenceImages, [])
  assert.deepEqual(character.referenceRequest.referenceImages, ['/zhangjiao.png'])
  assert.match(character.framePrompt, /洛阳宫城与饥困百姓/)
  assert.doesNotMatch(character.framePrompt, /张角|淡入/)
  assert.match(character.framePrompt, /不画具名人物/)

  const orphanedAppearance = await executeCodeNode({ code: SANGUO_FIRST_FRAME_BRANCH_CODE, context: {
    shot_script: { firstFrameMode: 'reference', visualTreatment: 'animated', animationStyle: 'character_illustration',
      visualPrompt: '洛阳宫城与饥困百姓。张角人物插画淡入。穿深灰色宽袖交领长袍，腰束棕褐布带。人物插画采用工笔画风。' },
    loop: { previous: undefined }, character_lookup: { names: ['张角'], existingAssets: [] }, character_assets: { items: [] },
  } })
  assert.doesNotMatch(orphanedAppearance.framePrompt, /张角|穿深灰|腰束|人物插画/)
  assert.match(orphanedAppearance.framePrompt, /洛阳宫城与饥困百姓|背景画面采用工笔画风/)

  const continued = await executeCodeNode({ code: SANGUO_FIRST_FRAME_BRANCH_CODE, context: {
    shot_script: { firstFrameMode: 'reuse_previous_tail', visualTreatment: 'animated', animationStyle: 'symbolic_transition', enteringCharacters: [] },
    loop: { previous: { last_frame: { url: '/previous-tail.png' } } }, character_lookup: { names: [], existingAssets: [] },
  } })
  assert.equal(continued.shouldGenerateAnimatedFirstFrame, false)
  assert.equal(continued.shouldGenerateAnimatedEndFrame, true)
})

test('saved first-frame branch upgrades once and keeps map portraits out of the generated geography plate', async () => {
  const previousManaged = SANGUO_FIRST_FRAME_BRANCH_CODE
    .replace(/const mapGeographyPrompt = [\s\S]*?(?=const framePrompt = )/, '')
    .replace("const frameReferenceImages = isStaticIllustration || animationStyle === 'historical_map' ? [] : referenceImages",
      'const frameReferenceImages = isStaticIllustration || mapPortraitLayers.length ? [] : referenceImages')
    .replace(": animationStyle === 'historical_map'\n    ? historicalMapPlatePrompt\n  ",
      ": mapPortraitLayers.length\n    ? [backgroundOnlyPrompt || '符合本镜已批准地理范围的古代历史地理地图', '只生成古代历史地理地图底板及获批准的山川、城址、边界与路线，不画任何人物、人物卡片或肖像；后期叠加已绑定的静态人物图层'].join('。')\n  ")
  assert.doesNotMatch(previousManaged, /historicalMapPlatePrompt/)
  const upgraded = refreshHistoricalMapBarePlateCode(previousManaged + '\n// 导演保留的资产审计。')
  assert.match(upgraded, /historicalMapPlatePrompt/)
  assert.match(upgraded, /导演保留的资产审计/)
  assert.equal(refreshHistoricalMapBarePlateCode(upgraded), upgraded)
  assert.equal(refreshMapPortraitBackgroundCode('const framePrompt = custom;'), 'const framePrompt = custom;')
  const result = await executeCodeNode({ code: upgraded, context: {
    shot_script: { firstFrameMode: 'reference', visualTreatment: 'animated', animationStyle: 'historical_map',
      visualPrompt: '当阳、长坂和周边山川道路构成古代历史地理底图。张飞静态肖像在长坂位置淡入。',
      illustrationLayers: [{ characterName: '张飞', x: .7, y: .5, scale: .24, enterStart: .2, enterDuration: .5,
        enterFromX: .8, enterFromY: .5, exitStart: 6.5, exitDuration: .5 }] },
    loop: { previous: undefined }, character_lookup: { names: ['张飞'], existingAssets: [{ characterName: '张飞', url: '/generated/zhangfei.png' }] },
  } })
  assert.equal(result.shouldGenerateAnimatedMapFrames, true)
  assert.deepEqual(result.frameReferenceImages, [], 'Kling image only receives the geography plate')
  assert.deepEqual(result.referenceRequest.referenceImages, ['/generated/zhangfei.png'], 'named portrait remains bound for the local compositor')
  assert.equal(result.referenceRequest.referenceBindings[0].characterName, '张飞')
  assert.match(result.framePrompt, /当阳、长坂和周边山川道路/)
  assert.match(result.framePrompt, /无字、无箭头、无人物/)
  assert.doesNotMatch(result.framePrompt, /张飞静态肖像在长坂位置淡入/)
})

test('first-frame branch merges cached and generated images into video character references', async () => {
  const result = await executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: { firstFrameMode: 'reference', firstFramePrompt: '竖屏历史电影首帧' },
      loop: { previous: undefined },
      character_lookup: {
        names: ['张角', '张宝', '张良'],
        existingAssets: [{ characterName: '张角', url: '/characters/zhangjiao.png', metadata: { continuityKey: '张角-v1' } }],
      },
      character_assets: {
        items: [
          { characterName: '张宝', url: '/generated/zhangbao.png', metadata: { continuityKey: '张宝-v1' } },
          { characterName: '张良', url: 'https://cdn.example.com/zhangliang.png', metadata: { continuityKey: '张良-v1' } },
        ],
      },
    },
  })
  assert.deepEqual(result.referenceRequest, {
    referenceImages: [
      '/characters/zhangjiao.png',
      '/generated/zhangbao.png',
      'https://cdn.example.com/zhangliang.png',
    ],
    referenceBindings: [
      { characterName: '张角', continuityKey: '张角-v1', role: 'identity' },
      { characterName: '张宝', continuityKey: '张宝-v1', role: 'identity' },
      { characterName: '张良', continuityKey: '张良-v1', role: 'identity' },
    ],
    referenceMode: 'three-view-front',
  })
})

test('first-frame code binds an explicit asset id despite a later same-name archive candidate', async () => {
  const approved={id:'approved-sheet',characterName:'张飞',url:'/approved.png',metadata:{continuityKey:'approved-context'}}
  const intermediate={id:'intermediate-sheet',characterName:'张飞',url:'/intermediate.png',metadata:{continuityKey:'intermediate-context'}}
  const context={shot_script:{firstFrameMode:'reference'},character_lookup:{names:['张飞'],existingAssets:[approved]},
    character_assets:{items:[intermediate]}}
  for (const selection of [{'张飞':'approved-sheet'},'{"张飞":"approved-sheet"}']) {
    const result=await executeCodeNode({code:SANGUO_FIRST_FRAME_BRANCH_CODE,context:{...context,input:{characterAssetSelections:selection}}})
    assert.deepEqual(result.referenceRequest.referenceImages,['/approved.png'])
    assert.deepEqual(result.referenceRequest.referenceBindings,[{characterName:'张飞',assetId:'approved-sheet',continuityKey:'approved-context',role:'identity'}])
  }
  const legacy=await executeCodeNode({code:SANGUO_FIRST_FRAME_BRANCH_CODE,context})
  assert.deepEqual(legacy.referenceRequest.referenceImages,['/intermediate.png'],'unselected workflows retain existing merge behavior')
  assert.equal(legacy.referenceRequest.referenceBindings[0].assetId,'intermediate-sheet')
  const repeated=await executeCodeNode({code:SANGUO_FIRST_FRAME_BRANCH_CODE,context:{...context,input:{characterAssetSelections:{'张飞':'approved-sheet'}},
    character_assets:{items:[approved,intermediate]}}})
  assert.deepEqual(repeated.referenceRequest.referenceImages,['/approved.png'],'identical already-archived copy does not create an ambiguous image')
})

test('selected frame assets fail before media on missing id, wrong actor, unusable url or conflicting duplicate', async () => {
  const approved={id:'approved-sheet',characterName:'张飞',url:'/approved.png'}
  const base={input:{characterAssetSelections:{'张飞':'approved-sheet'}},shot_script:{firstFrameMode:'reference'},character_lookup:{names:['张飞']}}
  for (const items of [[{...approved,id:'intermediate'}],[{...approved,characterName:'曹操'}],[{...approved,url:''}],
    [approved,{...approved,url:'/different.png'}],[]]) {
    await assert.rejects(executeCodeNode({code:SANGUO_FIRST_FRAME_BRANCH_CODE,context:{...base,character_assets:{items},
      character_lookup:{...base.character_lookup,existingImages:['/fallback.png']}}}),/CHARACTER_VISUAL_SELECTION_MISMATCH[\s\S]*approved-sheet/)
  }
  for (const value of ['invalid-json','[]','null',{'张飞':{}},{'张飞':''}]) {
    await assert.rejects(executeCodeNode({code:SANGUO_FIRST_FRAME_BRANCH_CODE,context:{...base,input:{characterAssetSelections:value},
      character_assets:{items:[approved]}}}),/CHARACTER_VISUAL_SELECTION_INVALID/)
  }
  const actorless=await executeCodeNode({code:SANGUO_FIRST_FRAME_BRANCH_CODE,context:{...base,character_lookup:{names:[]}}})
  assert.deepEqual(actorless.referenceRequest.referenceBindings,[],'environment-only shots do not require an absent selected actor')
})

test('continuous-frame reference budget cannot silently discard an explicitly selected actor', async () => {
  const entrance={name:'刘备',startSecond:0,endSecond:2,path:'右侧门口'}
  const result=await executeCodeNode({code:SANGUO_FIRST_FRAME_BRANCH_CODE,context:{
    input:{characterAssetSelections:{'张飞':'approved-sheet'}},shot_script:{firstFrameMode:'reuse_previous_tail',enteringCharacters:[entrance]},
    loop:{previous:{last_frame:{url:'/tail.png'}}},character_lookup:{names:['张飞','刘备'],existingAssets:[
      {id:'approved-sheet',characterName:'张飞',url:'/approved.png'},{id:'liu-sheet',characterName:'刘备',url:'/liu.png'}]},
    character_assets:{items:[{id:'intermediate',characterName:'张飞',url:'/intermediate.png'}]},
  }})
  assert.deepEqual(result.referenceRequest.referenceBindings.map((row:{assetId:string})=>row.assetId),['liu-sheet','approved-sheet'])
  await assert.rejects(executeCodeNode({code:SANGUO_FIRST_FRAME_BRANCH_CODE,context:{
    input:{characterAssetSelections:{'张飞':'approved-sheet'}},shot_script:{firstFrameMode:'reuse_previous_tail',enteringCharacters:[]},
    loop:{previous:{last_frame:{url:'/tail.png'}}},character_lookup:{names:['刘备','关羽','张飞'],existingAssets:[
      {id:'liu-sheet',characterName:'刘备',url:'/liu.png'},{id:'guan-sheet',characterName:'关羽',url:'/guan.png'},
      {id:'approved-sheet',characterName:'张飞',url:'/approved.png'}]},
  }}),/所选人物 张飞 超出当前身份参考容量/)
})

test('reference shots mark a later entrant as entering instead of placing them in frame one', async () => {
  const entrance = { name: '张角', startSecond: 0, endSecond: 3, path: '画面右侧低矮门口' }
  const result = await executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: {
        firstFrameMode: 'reference',
        initialCharacters: ['病人'],
        enteringCharacters: [entrance],
      },
      loop: { previous: undefined },
      character_lookup: {
        names: ['张角', '病人'],
        existingAssets: [
          { characterName: '张角', url: '/characters/zhangjiao.png', metadata: { continuityKey: '张角-eastern-han-v1' } },
          { characterName: '病人', url: '/characters/patient.png', metadata: { continuityKey: '病人-eastern-han-v1' } },
        ],
      },
    },
  })

  assert.deepEqual(result.referenceRequest.referenceBindings, [
    { characterName: '张角', continuityKey: '张角-eastern-han-v1', role: 'entering', entrance },
    { characterName: '病人', continuityKey: '病人-eastern-han-v1', role: 'identity' },
  ])
})

test('continuous shots keep entrants and existing multi-angle clothing identities', async () => {
  const entrance = { name: '年长党人', startSecond: 0, endSecond: 3, path: '画面右后方门口' }
  const result = await executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: {
        firstFrameMode: 'reuse_previous_tail',
        initialCharacters: ['张俭'],
        enteringCharacters: [entrance],
      },
      loop: { previous: { last_frame: { url: '/frames/previous-tail.png' } } },
      character_lookup: {
        names: ['张俭', '年长党人'],
        existingAssets: [
          { characterName: '张俭', url: '/characters/zhangjian.png', metadata: { continuityKey: '张俭-v1' } },
          { characterName: '年长党人', url: '/characters/elder.png', metadata: { continuityKey: '年长党人-v1' } },
        ],
      },
    },
  })

  assert.deepEqual(result.referenceRequest, {
    referenceImages: ['/characters/elder.png', '/characters/zhangjian.png'],
    referenceBindings: [{
      characterName: '年长党人',
      continuityKey: '年长党人-v1',
      role: 'entering',
      entrance,
    }, { characterName: '张俭', continuityKey: '张俭-v1', role: 'identity' }],
    referenceMode: 'three-view-all',
  })
})

test('continuous shots block entrants whose identity asset is unavailable', async () => {
  await assert.rejects(executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: {
        firstFrameMode: 'reuse_previous_tail',
        initialCharacters: ['张俭'],
        enteringCharacters: [{ name: '年长党人', startSecond: 0, endSecond: 3, path: '门口' }],
      },
      loop: { previous: { last_frame: { url: '/frames/previous-tail.png' } } },
      character_lookup: {
        names: ['张俭', '年长党人'],
        existingAssets: [{ characterName: '张俭', url: '/characters/zhangjian.png' }],
      },
    },
  }), /入场人物缺少三视图资产：年长党人/)
})

test('tail-frame code uses only an actual tail returned by the video model', async () => {
  const available = await executeCodeNode({
    code: SANGUO_TAIL_FRAME_CODE,
    context: { video_shot: { raw: { data: { task_result: { last_frame_url: 'https://cdn.example.com/tail.png' } } } } },
  })
  assert.equal(available.url, 'https://cdn.example.com/tail.png')
  assert.equal(available.available, true)
  assert.equal(available.source, 'video-model-output')

  const unavailable = await executeCodeNode({
    code: SANGUO_TAIL_FRAME_CODE,
    context: {
      video_shot: { url: 'https://cdn.example.com/clip.mp4' },
      end_frame: { url: 'https://cdn.example.com/target-tail.png' },
    },
  })
  assert.equal(unavailable.url, '')
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.source, 'unavailable')
  assert.match(String(unavailable.warning), /连续下一镜将被阻止/)
})

test('first-frame branch blocks a continuous shot instead of silently discarding its missing tail', async () => {
  await assert.rejects(executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: { firstFrameMode: 'reuse_previous_tail', firstFramePrompt: '新首帧' },
      loop: { previous: { last_frame: { url: '' } } },
      character_lookup: { existingImages: [] },
    },
  }), /阻止静默降级/)
})

test('tail-frame code accepts a system-extracted frame from the actual video', async () => {
  const result = await executeCodeNode({
    code: SANGUO_TAIL_FRAME_CODE,
    context: { video_shot: { url: 'https://cdn.example.com/clip.mp4', extractedLastFrameUrl: '/generated/tail.jpg' } },
  })
  assert.equal(result.url, '/generated/tail.jpg')
  assert.equal(result.available, true)
  assert.equal(result.source, 'extracted-from-video')
})

test('code placeholders inject JSON literals and resolve missing paths as undefined', async () => {
  const result = await executeCodeNode({
    code: `
      const title = \${input.title}
      const characters = \${shot.characters}
      const missing = \${loop.previous.last_frame.url}
      return { title, characters, missing: missing ?? null }
    `,
    context: { input: { title: '符水与饥民' }, shot: { characters: ['张角', '张宝'] }, loop: {} },
  })
  assert.deepEqual(result, {
    title: '符水与饥民',
    characters: ['张角', '张宝'],
    missing: null,
    executionLogs: [],
  })
})

test('code nodes can execute without Excel and return a context patch', async () => {
  const result = await executeCodeNode({
    code: `console.log('plain code'); return { total: params.a + params.b, contextPatch: { metrics: { ready: true } } }`,
    params: { a: 2, b: 3 },
    context: {},
  })
  assert.equal(result.total, 5)
  assert.deepEqual(result.contextPatch, { metrics: { ready: true } })
  assert.deepEqual(result.executionLogs, ['[log] plain code'])
})

test('restricted runtime rejects dynamic code generation and runaway scripts', async () => {
  await assert.rejects(
    executeCodeNode({ code: `return Function('return 1')()`, context: {} }),
    /Code generation from strings disallowed/,
  )
  await assert.rejects(
    executeCodeNode({ code: `return console.log.constructor('return process')()`, context: {} }),
    /Code generation from strings disallowed/,
  )
  await assert.rejects(
    executeCodeNode({ code: 'while (true) {}', context: {} }),
    /Script execution timed out/,
  )
})

test('parenthetical office titles cannot replace the actual costume description', async () => {
  const result = await executeCodeNode({ code: SANGUO_CHARACTER_LOOKUP_CODE, context: {
    shot_script: { characters: ['朝臣'], firstFramePrompt: '', lastFramePrompt: '', visualPrompt: '朝臣（功曹）站在画面右侧，圆脸无须，头戴黑色小冠，身穿深青色交领长袍，双手拱于胸前持竹简。' },
    character_lookup_result: { items: [], missingCharacters: [{ name: '朝臣', continuityKey: 'ep001-朝臣-v3' }] },
  } })
  assert.match(String(result.missingCharacters[0].description), /深青色交领长袍/)
  assert.match(String(result.missingCharacters[0].description), /无须/)
  assert.notEqual(result.missingCharacters[0].description, '功曹')
})
