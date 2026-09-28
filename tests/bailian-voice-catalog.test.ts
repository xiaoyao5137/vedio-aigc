import test from 'node:test'
import assert from 'node:assert/strict'
import { bailianVoiceOptions } from '../src/bailian-tts.ts'
import {readFile} from 'node:fs/promises'

test('both models include all official basic voices and correctly scoped system voices',()=>{
 for(const [variant,count] of [['flash',609],['plus',599]] as const){
  const voices=bailianVoiceOptions(`qwen-audio-3.0-tts-${variant}`)
  assert.equal(voices.length,count);assert.equal(voices.filter(v=>v.kind==='基础音色').length,597)
  assert.equal(new Set(voices.map(v=>v.value)).size,count)
  for(const v of voices){assert.match(v.value,/^[a-zA-Z0-9_.-]+$/);assert.ok(v.name);assert.ok(v.previewUrl);assert.ok(['男','女','未注明'].includes(v.gender))}
 }
 assert.equal(bailianVoiceOptions('qwen-audio-3.0-tts-plus').find(v=>v.value==='longanlufeng')?.name,'龙安鲁风')
 assert.equal(bailianVoiceOptions('qwen-audio-3.0-tts-flash').some(v=>v.value==='longanlufeng'),false)
 assert.deepEqual(bailianVoiceOptions('unsupported'),[])
})
test('installed preview pack covers every selectable basic voice',{skip:!process.env.TEST_TTS_PREVIEWS},async()=>{
 const urls=[...new Set(bailianVoiceOptions('qwen-audio-3.0-tts-flash').filter(v=>v.kind==='基础音色').map(v=>v.previewUrl))]
 for(const url of urls){const data=await readFile(`public${url}`);assert.equal(data.subarray(0,4).toString(),'RIFF',url);assert.equal(data.subarray(8,12).toString(),'WAVE',url)}
})
