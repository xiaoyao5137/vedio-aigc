import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {serveGeneratedAudio} from '../server/generated-audio.ts'
test('new audio is immediately available with MIME, HEAD, ranges and missing-file handling',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'tts-http-'))
 const server=createServer((req,res)=>void serveGeneratedAudio(req,res,()=>{res.statusCode=404;res.end()},root))
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address();assert.ok(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}/tts-abcd.wav`
 try{
  assert.equal((await fetch(url)).status,404)
  await mkdir(path.join(root,'public/generated'),{recursive:true});await writeFile(path.join(root,'public/generated/tts-abcd.wav'),Buffer.from('0123456789'))
  const full=await fetch(url);assert.equal(full.headers.get('content-type'),'audio/wav');assert.equal(await full.text(),'0123456789')
  const range=await fetch(url,{headers:{Range:'bytes=2-5'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-5/10');assert.equal(await range.text(),'2345')
  const suffix=await fetch(url,{headers:{Range:'bytes=-3'}});assert.equal(await suffix.text(),'789')
  assert.equal((await fetch(url,{headers:{Range:'bytes=50-'}})).status,416)
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'')
 }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})}
})
