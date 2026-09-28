// Explicit, local recovery of a completed TTS WAV whose fit check failed.
// Does not invoke a model, alter an execution, or select a "latest" audio file.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { narrationSynthesisReceiptIdentity, narrationSynthesisReceiptKey, narrationSynthesisParameters } from '../server/independent-narration.ts'
import { projectIndependentNarration, projectIndependentOffscreenDialogue } from '../server/narration-projection.ts'
import { originalVoiceScope } from '../server/bailian-voice-design.ts'

const args=process.argv.slice(2), option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]}
const ledgerId=option('--ledger'),sourceUrl=option('--source-url'),beatId=option('--segment'),proofPath=option('--proof'),apply=args.includes('--apply')
assert.ok(ledgerId&&beatId&&proofPath&&/^\/generated\/tts-[\da-f-]{36}\.wav$/.test(sourceUrl??''),'Explicit ledger, segment, original TTS WAV and proof are required')
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const client=new pg.Client({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
await client.connect()
try{
  await client.query('BEGIN READ ONLY')
  const ledger=(await client.query('SELECT id,status,node_id,created_at,duration_ms,request_data FROM model_execution_records WHERE id=$1',[ledgerId])).rows[0]
  assert.equal(ledger?.status,'failed','Source ledger must be failed after completed synthesis')
  const params=ledger.request_data.params,voice=params.narrationVoice??params.offscreenDialogueVoice
  assert.ok(voice?.voiceId&&voice.synthesisSeed,'Failed request must contain its locked voice identity')
  const model=(await client.query('SELECT id,provider,capability,settings FROM model_configs WHERE id=$1',[voice.modelId])).rows[0]
  assert.equal(model?.provider,'Bailian')
  assert.equal(originalVoiceScope(model),voice.accountScope)
  assert.equal(model.settings.model,voice.targetModel)
  const projection=(params.offscreenDialogueVoice?projectIndependentOffscreenDialogue:projectIndependentNarration)(ledger.request_data.prompt,params)
  const segment=projection.segments.find(segment=>segment.beatId===beatId)
  assert.ok(segment,'Explicit segment must belong to this failed request')
  assert.equal(projection.segments.indexOf(segment),0,'This orphan recovery requires proof of the first sequential synthesis')
  const sourcePath=path.join(process.cwd(),'public',sourceUrl),bytes=await fs.readFile(sourcePath),stat=await fs.stat(sourcePath)
  assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE')
  assert.equal(bytes.toString('ascii',12,16),'fmt ');assert.equal(bytes.readUInt32LE(16),16)
  assert.equal(bytes.readUInt16LE(20),1);assert.equal(bytes.readUInt16LE(22),1);assert.equal(bytes.readUInt16LE(34),16)
  assert.equal(bytes.toString('ascii',36,40),'data');assert.equal(bytes.readUInt32LE(40),bytes.length-44)
  const sampleRate=bytes.readUInt32LE(24),sampleCount=(bytes.length-44)/2,duration=sampleCount/sampleRate
  const finished=Date.parse(ledger.created_at),started=finished-ledger.duration_ms
  assert.ok(stat.mtimeMs>=started-1000&&stat.mtimeMs<=finished+1000,'Source WAV creation must match this failed call window')
  const wavs=[]
  for(const filename of await fs.readdir(path.dirname(sourcePath))){if(!/^tts-[\da-f-]{36}\.wav$/.test(filename))continue;const st=await fs.stat(path.join(path.dirname(sourcePath),filename));if(st.mtimeMs>=started-1000&&st.mtimeMs<=finished+1000)wavs.push(filename)}
  assert.deepEqual(wavs,[path.basename(sourcePath)],'Ambiguous call-window audio requires further evidence')
  const synthesis= narrationSynthesisParameters(model,voice,segment)
  const identity=narrationSynthesisReceiptIdentity(model,voice,segment),identityKey=narrationSynthesisReceiptKey(model,voice,segment)
  const proof={version:'explicit-narration-orphan-recovery-v1',at:new Date().toISOString(),ledgerId,nodeId:ledger.node_id,
    requestKey:ledger.request_data.requestKey,requestFingerprint:hash(JSON.stringify(ledger.request_data)),sourceUrl,sourceSha256:hash(bytes),
    sourceSampleRate:sampleRate,sourceSampleCount:sampleCount,sourceDuration:duration,sourceCreatedAt:stat.mtime.toISOString(),
    sourceCallWindow:{start:new Date(started).toISOString(),end:new Date(finished).toISOString(),matchingWavs:wavs},
    segment,voice,identityKey,applied:apply,modelCalls:0,executionWrites:0,sourceAudioWrites:0,
    bindingMethod:'explicit-source-request-and-sequential-first-synthesis',audibleVoiceIdentityCertified:false}
  const receipt={version:'narration-synthesis-v1',identityKey,identity,createdAt:new Date().toISOString(),recoveryProof:proof,
    result:{status:'succeeded',taskId:path.basename(sourcePath,'.wav').slice(4),url:sourceUrl,duration,durationSource:'pcm-samples',
      sampleRate,sampleCount,channels:1,format:'wav',bytes:bytes.length,sha256:hash(bytes),model:voice.targetModel,voice:voice.voiceId,
      rate:synthesis.rate,seed:synthesis.seed,instruction:synthesis.instruction??'',transcript:segment.text,transcriptSource:'input-text',
      characterName:voice.characterName??'旁白'}}
  const directory=path.resolve('.runtime/narration-syntheses'),destination=path.join(directory,identityKey+'.json')
  await client.query('COMMIT')
  if(apply){await fs.mkdir(directory,{recursive:true});await fs.writeFile(destination,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600})}
  await fs.writeFile(path.resolve(proofPath),JSON.stringify({...proof,receiptPath:destination},null,2),{flag:'wx',mode:0o600})
  console.log(JSON.stringify({identityKey,sourceUrl,sourceSha256:proof.sourceSha256,sourceDuration:duration,beatId,applied:apply,modelCalls:0,executionWrites:0}))
}catch(error){await client.query('ROLLBACK');throw error}finally{await client.end()}
