import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { bailianTtsEndpoint, buildBailianTtsParameters, pcmToWav, callBailianTts } from '../server/bailian-tts.ts'
import { inspectExperienceResponse, modelExperienceFields } from '../src/model-experience.ts'

const model = { id: 'tts', provider: 'Bailian', capability: 'audio', settings: { endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'test-secret', model: 'qwen-audio-3.0-tts-flash' } }
test('TTS uses the configured workspace and rejects ambiguous endpoint paths', () => {
  assert.equal(bailianTtsEndpoint(model.settings.endpoint), 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference')
  assert.throws(() => bailianTtsEndpoint('https://example.com/wrong'), /路径/)
  assert.throws(() => bailianTtsEndpoint('http://example.com'), /HTTPS/)
  assert.throws(() => bailianTtsEndpoint('https://user:secret@example.com'), /HTTPS/)
})
test('voice instructions and numeric controls survive settings/experience routing', () => {
  const p = buildBailianTtsParameters({voice:'saved',instruction:'平静'}, {voice:'other',instruction:'愤怒',rate:'0.8',seed:'42'})
  assert.equal(p.voice, 'other'); assert.equal(p.instruction, '愤怒'); assert.equal(p.rate, 0.8); assert.equal(p.seed, 42)
  for (const invalid of [{rate:0},{pitch:3},{volume:101},{seed:0.5},{sampleRate:12345}]) assert.throws(() => buildBailianTtsParameters({},invalid), /TTS_INPUT_INVALID/)
  assert.ok(modelExperienceFields(model).some(f=>f.key==='instruction'))
})
test('WAV header uses complete PCM length and rejects partial samples',()=>{
  const wav=pcmToWav(Buffer.alloc(48000),24000)
  assert.equal(wav.readUInt32LE(40),48000); assert.equal(wav.readUInt32LE(24),24000)
  assert.equal(wav.readUInt32LE(4),48036)
  assert.throws(()=>pcmToWav(Buffer.alloc(1),24000),/不完整/)
  assert.throws(()=>pcmToWav(Buffer.alloc(0),24000),/为空/)
})
for (const scenario of ['success','failure','partial','empty','wrong-id'] as const) {
  test(`WebSocket TTS ${scenario}: task identity, completion and durable audio`,async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'bailian-test-'))
    const server=new WebSocketServer({port:0}); await new Promise<void>(r=>server.on('listening',r))
    const address=server.address(); assert.ok(address && typeof address!=='string')
    const actions:string[]=[]
    server.on('connection',(ws,req)=>{
      assert.equal(req.headers.authorization,'Bearer test-secret')
      ws.on('message',data=>{
        const msg=JSON.parse(data.toString()); const id=msg.header.task_id; actions.push(msg.header.action)
        const emit=(event:string,extra={})=>ws.send(JSON.stringify({header:{task_id:scenario==='wrong-id'?'wrong':id,event,...extra}}))
        if(msg.header.action==='run-task') emit('task-started')
        if(msg.header.action==='continue-task') assert.equal(msg.payload.input.text,'完整台词')
        if(msg.header.action==='finish-task') {
          if(scenario==='failure') return emit('task-failed',{error_code:'InvalidParameter',error_message:'test-secret rejected'})
          if(scenario!=='empty') ws.send(Buffer.alloc(48000))
          if(scenario==='partial') return ws.close()
          emit('task-finished')
        }
      })
    })
    try {
      const run=callBailianTts(model,'完整台词',{}, {root,connect:(_url,options)=>new WebSocket(`ws://127.0.0.1:${address.port}`,options)})
      if(scenario==='success') {
        const result=await run; assert.equal(result.body.duration,1)
        const data=await readFile(path.join(root,'public',result.body.url)); assert.equal(data.length,48044)
        assert.deepEqual(actions,['run-task','continue-task','finish-task'])
        const inspected=inspectExperienceResponse(result.body,'audio'); assert.equal(inspected.succeeded,true);assert.equal(inspected.media.length,1)
      } else await assert.rejects(run,error=>{assert.ok(error instanceof Error); assert.ok(!error.message.includes('test-secret'));return true})
    } finally {for(const c of server.clients)c.terminate();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})}
  })
}
