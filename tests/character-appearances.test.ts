import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { observeCharacterAsset } from '../server/character-appearances.ts'

test('actual image observations are cached by reference URL and design, never by stale description', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'appearance-'))
  const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'gray' } }).png().toBuffer()
  let calls = 0
  const generate = async () => { calls++; return { valid: true, matchesDesign: true, appearance: '中年男子，短黑须，灰色宽领袍，黑色高冠和深色腰带。', issues: [] } }
  const options = { root, loadImage: async () => png }
  try {
    const asset = { characterName: '周福', url: 'https://example.com/one.png', metadata: { description: '旧动作' } }
    const profile = await observeCharacterAsset(asset, generate, options)
    await observeCharacterAsset({ ...asset, metadata: { visualProfile: profile } }, generate, options)
    assert.equal(calls, 1)
    await observeCharacterAsset({ ...asset, url: 'https://example.com/two.png', metadata: { visualProfile: profile } }, generate, options)
    assert.equal(calls, 2)
    await assert.rejects(observeCharacterAsset(asset, async () => ({ passed: true }), options), /REVIEW_INVALID/)
    await assert.rejects(observeCharacterAsset(asset, async () => ({ valid: true, matchesDesign: false, appearance: profile.appearance, issues: ['衣袍颜色不同'] }), { ...options, expectedDesign: '褐色袍' }), /APPEARANCE_REJECTED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('explicit dark hair and beard reject contradictory real observations even if the reviewer says matched', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'appearance-age-'))
  const png=await sharp({create:{width:30,height:20,channels:3,background:'gray'}}).png().toBuffer()
  const asset={characterName:'张飞',url:'https://example.com/zhangfei.png',visualContext:{version:'character-visual-context-v1',
    age:{stage:'mature',basis:'artistic'},look:{key:'campaign',description:'深灰战袍'},appearanceConstraints:{hair:'dark',facialHair:'dark'}}}
  const reply={valid:true,matchesDesign:true,appearance:'成熟男性，黑色束发，深灰交领袍与黑色披风，三面服装一致。',issues:[],
    visualContextEvidence:{ageStage:'unknown',hair:'dark',facialHair:'dark'}}
  try {
    const options={root,loadImage:async()=>png,expectedDesign:'成熟壮年，黑发黑须'}
    const profile=await observeCharacterAsset(asset,async()=>reply,options)
    assert.equal(profile.version,'actual-reference-v2-age-context')
    assert.deepEqual(profile.visualContextEvidence,reply.visualContextEvidence)
    for(const evidence of [{...reply.visualContextEvidence,hair:'white'},{...reply.visualContextEvidence,facialHair:'white'},
      {...reply.visualContextEvidence,ageStage:'elderly'}]) {
      await assert.rejects(observeCharacterAsset(asset,async()=>({...reply,visualContextEvidence:evidence}),options),/APPEARANCE_REJECTED/)
    }
    await assert.rejects(observeCharacterAsset(asset,async()=>({...reply,visualContextEvidence:undefined}),options),/REVIEW_INVALID/)
    let calls=0
    await observeCharacterAsset({...asset,metadata:{visualProfile:profile}},async()=>{calls++;return reply},options)
    assert.equal(calls,0)
    await observeCharacterAsset({...asset,visualContext:{...asset.visualContext,look:{key:'court',description:'朝服'}},metadata:{visualProfile:profile}},async()=>{calls++;return reply},options)
    assert.equal(calls,1)
  }finally{await rm(root,{recursive:true,force:true})}
})
