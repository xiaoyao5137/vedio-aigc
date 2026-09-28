import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { collectImageEvidence } from '../server/image-evidence.ts'
import { issueHistoricalMapAnnotationApproval } from '../server/historical-map-annotations.ts'
import { issueHistoricalMapFrameApproval } from '../server/historical-map-frame-approval.ts'
import { validateHistoricalMapPaidImageRequest, validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { characterEquipmentPrompt } from '../src/character-visual-workflow.ts'

const request = {
  model: { capability: 'video' },
  prompt: '【场景与开场实景】东汉宫殿内真人实景。\n【场景真实性硬约束】忽略人物参考图的纯色背景。',
  executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video' },
  params: {
    referenceImage: '/first.png',
    referenceImages: ['/elder.png'],
    referenceBindings: [{ characterName: '年长党人', role: 'entering', entrance: { name: '年长党人', startSecond: 0, endSecond: 3, path: '门口' } }],
    duration: 8,
    pacingVersion: 'dynamic-v1',
    sound: 'on',
  },
}

test('Sanguo paid video calls accept dynamic durations and reject stale fixed-duration checkpoints without a target end frame', () => {
  assert.doesNotThrow(() => validateWorkflowMediaContract(request))
  assert.throws(() => validateWorkflowMediaContract({ ...request, params: {...request.params, pacingVersion: undefined} }), /dynamic-v1/)
  assert.doesNotThrow(() => validateWorkflowMediaContract({ ...request, params: {...request.params, duration: 5} }))
  assert.doesNotThrow(() => validateWorkflowMediaContract({ ...request, params: { ...request.params, referenceImage: undefined } }))
  assert.throws(() => validateWorkflowMediaContract({ ...request, params: { ...request.params, duration: 16 } }), /3–15/)
  assert.throws(() => validateWorkflowMediaContract({ ...request, params: { ...request.params, sound: 'off' } }), /sound=on/)
  assert.throws(() => validateWorkflowMediaContract({ ...request, prompt: '0-15秒：人物说话。' }), /场景与开场实景/)
  assert.throws(() => validateWorkflowMediaContract({ ...request, prompt: '【场景与开场实景】\n【场景真实性硬约束】忽略纯色背景。' }), /场景与开场实景/)
  assert.throws(() => validateWorkflowMediaContract({ ...request, prompt: '【场景与开场实景】东汉宫殿。' }), /真实性约束/)
  assert.throws(() => validateWorkflowMediaContract({
    ...request,
    params: {
      ...request.params,
      referenceImages: ['/elder.png', '/visitor.png'],
      referenceBindings: [
        { characterName: '年长党人', role: 'identity' },
        { characterName: '访客', role: 'entering', entrance: { name: '访客', startSecond: 0, endSecond: 3, path: '门口' } },
      ],
    },
  }), /开场已声明/)
  assert.throws(() => validateWorkflowMediaContract({
    ...request,
    params: { ...request.params, referenceBindings: [{ characterName: '年长党人', role: 'entering', entrance: {} }] },
  }), /开场已声明/)
})

test('paid video reference must match the current requested life stage instead of only the character name', () => {
  const context={version:'character-visual-context-v1',age:{stage:'adult',basis:'artistic'},look:{key:'robe',description:'素色长袍'},appearanceConstraints:{hair:'dark',facialHair:'dark'}}
  const params={...request.params,characterVisuals:[{name:'年长党人',visualContext:context}],
    referenceBindings:[{...request.params.referenceBindings[0],visualContext:context}]}
  assert.doesNotThrow(()=>validateWorkflowMediaContract({...request,params}))
  assert.throws(()=>validateWorkflowMediaContract({...request,params:{...params,referenceBindings:request.params.referenceBindings}}),/没有年龄与场景造型/)
  assert.throws(()=>validateWorkflowMediaContract({...request,params:{...params,characterVisuals:[]}}),/覆盖本镜/)
  assert.throws(()=>validateWorkflowMediaContract({...request,params:{...params,characterVisuals:[{name:'曹操',visualContext:context}]}}),/本镜唯一具名人物|覆盖本镜/)
  assert.throws(()=>validateWorkflowMediaContract({...request,params:{...params,referenceBindings:[{...params.referenceBindings[0],visualContext:{...context,age:{stage:'elderly',basis:'artistic'}}}]}}),/年龄阶段/)
})

test('paid video requires each declared character weapon to retain its archived binding and prompt text', () => {
  const binding={id:'spear-1',characterName:'年长党人',name:'长矛',kind:'weapon',description:'青铜长矛',imageUrl:'',
    matchedName:'长矛',matchReason:'exact-name',requirementSource:'shot_script.characterEquipment'}
  const params={...request.params,characters:['年长党人'],characterEquipment:[{name:'年长党人',equipmentNames:['长矛']}],equipmentBindings:[binding]}
  const equipped={...request,prompt:request.prompt+characterEquipmentPrompt([binding]),params}
  assert.doesNotThrow(()=>validateWorkflowMediaContract(equipped))
  assert.throws(()=>validateWorkflowMediaContract({...equipped,prompt:request.prompt}),/装备名称、描述与资产编号/)
  assert.throws(()=>validateWorkflowMediaContract({...equipped,params:{...params,equipmentBindings:[]}}),/装备绑定/)
  assert.throws(()=>validateWorkflowMediaContract({...equipped,params:{...params,equipmentBindings:[{...binding,characterName:'访客'}]}}),/装备绑定/)
  assert.throws(()=>validateWorkflowMediaContract({...equipped,params:{...params,characterEquipment:[{name:'年长党人',equipmentNames:['长矛','长剑']}]}}),/装备绑定/)
  assert.doesNotThrow(()=>validateWorkflowMediaContract(request),'old saved shots without structured equipment remain resumable')
})

test('ambiguous stale first frames are rejected instead of silently changing generation mode', () => {
  const freshRequest = {
    ...request,
    params: {
      ...request.params,
      referenceImages: ['/zhang-jiao.png', '/ma-yuanyi.png', '/tang-zhou.png'],
      referenceBindings: [
        { characterName: '张角', role: 'identity' },
        { characterName: '马元义', role: 'identity' },
        { characterName: '唐周', role: 'identity' },
      ],
    },
  }
  assert.throws(() => validateWorkflowMediaContract(freshRequest), /开场已声明/)
  assert.equal(freshRequest.params.referenceImage, '/first.png')
})

test('continuous identity references require an explicit opening cast and visible name in the actual frame description', () => {
  const known = { ...request,
    prompt: '【场景与开场实景】年长党人在东汉宫殿。\n【场景真实性硬约束】实际首帧锁定场景。',
    params: { ...request.params, initialCharacters: ['年长党人'], referenceBindings: [{ characterName: '年长党人', role: 'identity' }] },
  }
  assert.doesNotThrow(() => validateWorkflowMediaContract(known))
  assert.throws(() => validateWorkflowMediaContract({ ...known, params: { ...known.params, initialCharacters: ['未入画访客'] } }), /开场已声明/)
  assert.throws(() => validateWorkflowMediaContract({ ...known, prompt: request.prompt }), /开场已声明/)
})

test('editorial scene labels retain the paid-request scene and identity contract', () => {
  const editorial = {
    ...request,
    prompt: '【场景与开场画面】东汉宫殿内，年长党人立于门旁。\n【视觉处理硬约束】生成真实空间深度和自然光影，人物附件仅定义身份，忽略纯色底和三视图排版。',
    params: {
      ...request.params,
      initialCharacters: ['年长党人'],
      referenceBindings: [{ characterName: '年长党人', role: 'identity' }],
    },
  }
  assert.doesNotThrow(() => validateWorkflowMediaContract(editorial))
})

test('the boundary-frame contract does not affect unrelated video workflows', () => {
  assert.doesNotThrow(() => validateWorkflowMediaContract({
    model: { capability: 'video' },
    executionContext: { workflowId: 'wf-story', nodeId: 'node-video' },
    params: { duration: 3 },
  }))
})

test('animated maps require both generated boundary frames and accept a scene-cut first frame', () => {
  const animated = {
    ...request,
    prompt: '【本镜影视处理】animated_map / episode_opening\n【场景与开场画面】写实东汉地图。\n【视觉处理硬约束】地图文字保持稳定。',
    params: {
      ...request.params,
      visualTreatment: 'animated_map',
      referenceImage: '/kling-first.png',
      endImage: '/kling-end.png',
      referenceImages: [],
      referenceBindings: [],
      contentContractVersion: 'cinematic-v1',
      continuityMode: 'scene_cut',
      firstFrameMode: 'reference',
      characters: [],
      initialCharacters: [],
      presentCharacters: [],
      worldState: { settingId: 'map', characters: [] },
      audioType: '旁白',
      audioText: '东汉疆域。',
    },
  }
  assert.doesNotThrow(() => validateWorkflowMediaContract(animated))
  assert.throws(() => validateWorkflowMediaContract({ ...animated, params: { ...animated.params, referenceImage: undefined } }), /可灵首帧/)
  assert.throws(() => validateWorkflowMediaContract({ ...animated, params: { ...animated.params, endImage: undefined } }), /目标尾帧/)
})

test('historical map portraits reach the paid gate only with signed clean frames, map annotations and matching static layers', async () => {
  const cwd = process.cwd()
  const root = await mkdtemp(path.join(os.tmpdir(), 'sanguo-map-paid-gate-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  try {
    await sharp({ create: { width: 160, height: 90, channels: 3, background: '#e9dbb5' } })
      .png().toFile(path.join(generated, 'map-first.png'))
    await sharp({ create: { width: 160, height: 90, channels: 3, background: '#c8d5ac' } })
      .png().toFile(path.join(generated, 'map-last.png'))
    const firstUrl = '/generated/map-first.png', endUrl = '/generated/map-last.png'
    const firstEvidence = await collectImageEvidence({ items: [{ role: 'first', url: firstUrl }] }, root)
    const finalEvidence = await collectImageEvidence({ items: [{ role: 'first', url: firstUrl },
      { role: 'end', url: endUrl }] }, root)
    const frame = (item: Record<string, unknown>) => ({ role: item.role, sourceUrl: item.url,
      evidenceReferenceImage: item.referenceImage, bakedPeople: false, unreadableText: false,
      observedLabels: [], approvedLabels: [], routeMarksVisible: false, routes: [],
      hardChecks: { peopleFree: true, labelsApproved: true, routesCorrect: true, geographyConsistent: true }, issues: [] })
    const frameReview = (evidence: typeof firstEvidence) => ({ version: 'historical-map-frame-review-v1',
      passed: true, evidenceUrl: evidence.evidenceUrl, frames: evidence.items.map(frame), issues: [] })
    const shot = { visualPrompt: '无字无人物的当阳长坂历史地理底图。',
      lastFramePrompt: '同一地理范围的无字无人物历史地图。',
      videoPrompt: '山川与城址轻微移动，不绘制人物、字形或路线箭头。' }
    const mapAnnotations = { version: 'historical-map-annotations-v1' as const,
      orientation: 'north-up' as const, sourceRefs: ['[史料2]'], labels: [], routes: [] }
    const mapShot = { ...shot, animationStyle: 'historical_map', animationAesthetic: 'historical_cartography',
      duration: 8, mapAnnotations }
    const firstGate = await issueHistoricalMapFrameApproval({ review: frameReview(firstEvidence),
      evidence: firstEvidence, shot: mapShot, reviewExecutionId: 'model-run-test-first-review' }, root)
    const mapFrameGate = await issueHistoricalMapFrameApproval({ review: frameReview(finalEvidence),
      evidence: finalEvidence, shot: mapShot, prior: firstGate, reviewExecutionId: 'model-run-test-final-review' }, root)
    const approvedScene = { id: 'scene-map', editorialRole: 'episode_opening', animationStyle: 'historical_map',
      targetDuration: 8, title: '当阳长坂地理', historicalBasis: '[史料2] 及於當陽之長阪。',
      requiredBeats: [{ description: '介绍当阳长坂的山川方位。' }],
      contextPayload: { geographicFocus: ['当阳长坂'] } }
    const mapAnnotationApproval = await issueHistoricalMapAnnotationApproval({ plan: mapAnnotations,
      review: { decision: 'pass', issues: [], evidence: ['[史料2] 当阳长坂地理范围已核查。'],
        approvedSourceRefs: ['[史料2]'], approvedLabels: [], approvedParties: [], approvedRouteIds: [] },
      historicalSources: { citations: [{ index: 2, title: '三國志/卷36', content: '及於當陽之長阪。' }] },
      approvedScene,
      reviewExecutionId: 'model-run-test-annotation-review' }, root)
    process.chdir(root)
    const firstPaidImage = { model: { capability: 'image' },
      executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-animated-map-first-frame' },
      params: { visualTreatment: 'animated', animationStyle: 'historical_map', animationAesthetic: 'historical_cartography',
        mapEditorialRole: 'episode_opening', mapDuration: 8, mapAnnotations, mapAnnotationApproval,
        mapApprovedScene: approvedScene } }
    assert.doesNotThrow(() => validateHistoricalMapPaidImageRequest(firstPaidImage))
    assert.throws(() => validateHistoricalMapPaidImageRequest({ ...firstPaidImage,
      params: { ...firstPaidImage.params, mapAnnotationApproval: undefined } }), /MAP_ANNOTATIONS_UNAPPROVED/,
    'an old execution must not buy a first image by skipping the new annotation review')
    assert.throws(() => validateHistoricalMapPaidImageRequest({ ...firstPaidImage,
      params: { ...firstPaidImage.params, mapDuration: undefined } }), /MAP_ANNOTATIONS_INVALID/)
    assert.throws(() => validateHistoricalMapPaidImageRequest({ ...firstPaidImage,
      params: { ...firstPaidImage.params, animationAesthetic: 'physical_sand_table' } }),
    /HISTORICAL_MAP_AESTHETIC_REQUIRED/)
    assert.throws(() => validateHistoricalMapPaidImageRequest({ ...firstPaidImage,
      params: { ...firstPaidImage.params, mapEditorialRole: 'story' } }), /HISTORICAL_MAP_ROLE_INVALID/)
    assert.throws(() => validateHistoricalMapPaidImageRequest({ ...firstPaidImage,
      params: { ...firstPaidImage.params, mapApprovedScene: { ...approvedScene, id: 'other-scene' } } }),
    /MAP_ANNOTATIONS_UNAPPROVED/)
    const endPaidImage = { model: { capability: 'image' },
      executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-end-frame' },
      params: { visualTreatment: 'animated', animationStyle: 'historical_map', animationAesthetic: 'historical_cartography',
        mapEditorialRole: 'episode_opening', referenceImage: firstUrl, mapFirstGate: firstGate, mapShot } }
    assert.doesNotThrow(() => validateHistoricalMapPaidImageRequest(endPaidImage))
    assert.throws(() => validateHistoricalMapPaidImageRequest({ ...endPaidImage,
      params: { ...endPaidImage.params, mapFirstGate: undefined } }), /HISTORICAL_MAP_FRAME_APPROVAL_INVALID/,
    'an old execution must not buy an end image by skipping first-frame visual review')
    assert.throws(() => validateHistoricalMapPaidImageRequest({ ...endPaidImage,
      params: { ...endPaidImage.params, mapFirstGate: { ...firstGate, signature: '0'.repeat(64) } } }),
    /HISTORICAL_MAP_FRAME_APPROVAL_INVALID/)
    assert.throws(() => validateHistoricalMapPaidImageRequest({ ...endPaidImage,
      params: { ...endPaidImage.params, referenceImage: endUrl } }), /HISTORICAL_MAP_FIRST_FRAME_GATE_REQUIRED/)
    assert.throws(() => validateHistoricalMapPaidImageRequest({ ...endPaidImage,
      params: { ...endPaidImage.params, mapShot: { ...mapShot, visualPrompt: '另一镜地图。' } } }),
    /HISTORICAL_MAP_FIRST_FRAME_GATE_REQUIRED/)
    assert.doesNotThrow(() => validateHistoricalMapPaidImageRequest({ ...endPaidImage,
      params: { ...endPaidImage.params, resumeTaskId: 'already-paid-provider-task' } }),
    'resuming an already submitted paid task must not submit a fresh image')
  const unknown = { status: 'unknown' }
  const layer = { characterName: '张飞', x: .72, y: .52, scale: .24, enterStart: .2, enterDuration: .4,
    enterFromX: .82, enterFromY: .52, exitStart: 7.4, exitDuration: .5 }
  const map = { ...request,
    prompt: '【本镜影视处理】animated / episode_opening\n【场景与开场画面】当阳与长坂的历史地理底图，不画人物。\n【视觉处理硬约束】地图保留真实山川关系。',
    params: { ...request.params, visualTreatment: 'animated', editorialRole: 'episode_opening', animationStyle: 'historical_map',
      animationAesthetic: 'historical_cartography', referenceImage: firstUrl, endImage: endUrl,
      mapFrameGate, mapAnnotations, mapAnnotationApproval, mapShot,
      referenceImages: ['/generated/zhangfei.png'], referenceBindings: [{ characterName: '张飞', role: 'identity' }],
      contentContractVersion: 'cinematic-v1', continuityMode: 'scene_cut', firstFrameMode: 'reference',
      characters: ['张飞'], initialCharacters: [], presentCharacters: ['张飞'], endCharacters: ['张飞'],
      illustrationLayers: [layer], videoTimeline: '地图移动时张飞静态肖像淡入，内部不动。',
      worldState: { settingId: 'map', characters: [{ name: '张飞', position: unknown, heldProps: unknown, pendingAction: unknown }] },
      audioType: '旁白', audioText: '张飞率部到达长坂。', narrationVoice: { voiceId: 'narrator' }, subtitlePolicy: 'none' },
  }
  assert.doesNotThrow(() => validateWorkflowMediaContract(map))
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params, mapFrameGate: undefined } }),
    /HISTORICAL_MAP_FRAME_GATE_REQUIRED|HISTORICAL_MAP_FRAME_APPROVAL_INVALID/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params,
    mapFrameGate: { ...mapFrameGate, signature: '0'.repeat(64) } } }), /HISTORICAL_MAP_FRAME_APPROVAL_INVALID/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params, mapAnnotationApproval: undefined } }),
    /MAP_ANNOTATIONS_UNAPPROVED/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params, mapShot: undefined } }),
    /HISTORICAL_MAP_SHOT_REQUIRED/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params,
    mapShot: { ...mapShot, visualPrompt: '同一注释计划，但另一张未经审核的地理底板。' } } }),
  /HISTORICAL_MAP_SHOT_REQUIRED/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params, editorialRole: 'story' } }),
    /HISTORICAL_MAP_ROLE_INVALID/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params,
    mapShot: { ...mapShot, mapAnnotations: { ...mapAnnotations, labels: [{ text: '当阳方', x: .5, y: .5,
      sourceRef: '[史料2]' }] } } } }), /HISTORICAL_MAP_SHOT_REQUIRED/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params,
    mapAnnotationApproval: { ...mapAnnotationApproval, signature: '0'.repeat(64) } } }), /MAP_ANNOTATIONS_UNAPPROVED/)
  const inventedAnnotations = { ...mapAnnotations, labels: [{ text: '当阳方', x: .5, y: .5, sourceRef: '[史料2]' }] }
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params,
    mapAnnotations: inventedAnnotations, mapShot: { ...mapShot, mapAnnotations: inventedAnnotations } } }),
  /HISTORICAL_MAP_SHOT_REQUIRED/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params, illustrationLayers: [] } }), /静态人物图层/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params, referenceImages: [] } }), /同名已归档人物图片/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params,
    referenceBindings: [{ characterName: '刘备', role: 'identity' }] } }), /同名已归档人物图片/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params, narrationVoice: undefined } }), /独立画外旁白/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params, audioType: '对白' } }), /独立画外旁白/)
  assert.throws(() => validateWorkflowMediaContract({ ...map, params: { ...map.params, endImage: undefined } }),
    /HISTORICAL_MAP_FRAME_GATE_MISMATCH|目标尾帧/)
    const thumbnailPath = path.join(root, 'public', mapFrameGate.frames[1].evidenceReferenceImage)
    const thumbnailBytes = await readFile(thumbnailPath)
    await writeFile(thumbnailPath, 'tampered preview bytes')
    assert.throws(() => validateWorkflowMediaContract(map), /HISTORICAL_MAP_FRAME_APPROVAL_INVALID/,
      'signed approval must still match the actual model-viewed image thumbnail')
    await writeFile(thumbnailPath, thumbnailBytes)
    const evidencePath = path.join(root, 'public', mapFrameGate.evidenceUrl)
    const evidenceBytes = await readFile(evidencePath)
    await writeFile(evidencePath, 'tampered evidence JSON')
    assert.throws(() => validateWorkflowMediaContract(map), /HISTORICAL_MAP_FRAME_APPROVAL_INVALID/,
      'signed approval must still match the saved evidence report')
    await writeFile(evidencePath, evidenceBytes)
    await writeFile(path.join(generated, 'map-last.png'), 'tampered bytes')
    assert.throws(() => validateWorkflowMediaContract(map),
      /HISTORICAL_MAP_FRAME_APPROVAL_INVALID|HISTORICAL_MAP_FRAME_GATE_MISMATCH/)
  } finally { process.chdir(cwd); await rm(root, { recursive: true, force: true }) }
})

test('character illustration requires one still frame, independent narration and identity references', () => {
  const animated = {
    ...request,
    prompt: '【本镜影视处理】animated / story\n【场景与开场画面】张角的成熟水墨历史人物插画。\n【视觉处理硬约束】锁定人物身份。',
    params: { ...request.params, visualTreatment: 'animated', editorialRole: 'story', animationStyle: 'character_illustration', animationAesthetic: 'ink_wash',
      referenceImage: '/first.png', endImage: undefined, contentContractVersion: 'cinematic-v1', continuityMode: 'scene_cut', firstFrameMode: 'reference',
      characters: ['张角'], initialCharacters: ['张角'], presentCharacters: ['张角'], referenceImages: ['/zhangjiao.png'],
      referenceBindings: [{ characterName: '张角', role: 'identity' }], worldState: { settingId: 'illustration', characters: [{ name: '张角', position: { status: 'unknown' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' } }] },
      audioType: '旁白', audioText: '张角以符水为人疗病。', narrationVoice: { voiceId: 'narrator' } },
  }
  assert.doesNotThrow(() => validateWorkflowMediaContract(animated))
  assert.throws(() => validateWorkflowMediaContract({ ...animated, params: { ...animated.params, animationAesthetic: 'anime' } }), /animationAesthetic/)
  assert.throws(() => validateWorkflowMediaContract({ ...animated, params: { ...animated.params, audioType: '对白' } }), /只使用画外旁白/)
  assert.throws(() => validateWorkflowMediaContract({ ...animated, params: { ...animated.params, narrationVoice: undefined } }), /独立旁白音色/)
})

test('cinematic reverse coverage uses identity references without forcing same-frame pixels, and ambient audio stays explicit',()=>{
 const unknown={status:'unknown'};
 const worldState={settingId:'courtyard',characters:[{name:'年长党人',position:unknown,heldProps:unknown,pendingAction:unknown},{name:'访客',position:unknown,heldProps:unknown,pendingAction:unknown}]};
 const cinematic={...request,prompt:'【场景与开场实景】年长党人在门旁，访客在画外。\n【场景真实性硬约束】人物资产只作身份参考。',params:{...request.params,contentContractVersion:'cinematic-v1',continuityMode:'coverage_cut',firstFrameMode:'reference',referenceImage:undefined,initialCharacters:['年长党人'],presentCharacters:['年长党人','访客'],worldState,audioType:'环境声',audioText:'',referenceBindings:[{characterName:'年长党人',role:'identity'}]}};
 assert.doesNotThrow(()=>validateWorkflowMediaContract(cinematic));
 assert.throws(()=>validateWorkflowMediaContract({...cinematic,params:{...cinematic.params,referenceImage:'/previous-tail.jpg'}}),/新机位首帧缺少实际图片验收凭证/);
 assert.throws(()=>validateWorkflowMediaContract({...cinematic,params:{...cinematic.params,firstFrameMode:'reuse_previous_tail'}}),/firstFrameMode/);
 assert.throws(()=>validateWorkflowMediaContract({...cinematic,params:{...cinematic.params,audioText:'伪装成沉默的台词'}}),/环境声空台词/);
 assert.throws(()=>validateWorkflowMediaContract({...cinematic,params:{...cinematic.params,audioType:'对白'}}),/完整台词/);
 assert.throws(()=>validateWorkflowMediaContract({...cinematic,params:{...cinematic.params,contentContractVersion:'cinematic-v999'}}),/未知版本/);
 assert.throws(()=>validateWorkflowMediaContract({...cinematic,params:{...cinematic.params,continuityMode:'tail_continuation',firstFrameMode:'reuse_previous_tail'}}),/前镜实际尾帧/);
});
