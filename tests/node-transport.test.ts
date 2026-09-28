import test from 'node:test'
import assert from 'node:assert/strict'
import { NODE_REQUEST_RETRIES, droppedNodeRequest, requestNodeJson } from '../src/node-transport.ts'
import { modelRetryStopped } from '../src/model-failure.ts'

/** Scripted transport: one outcome per attempt, recording calls and backoff waits. */
function harness(...outcomes: { value?: unknown; error?: string }[]) {
  const calls: number[] = []
  const waits: number[] = []
  return {
    calls,
    waits,
    send: async () => {
      const outcome = outcomes[Math.min(calls.length, outcomes.length - 1)]
      calls.push(calls.length + 1)
      if (outcome.error) throw Error(outcome.error)
      return outcome.value
    },
    wait: async (ms: number) => { waits.push(ms) },
  }
}

const KEY = 'record-6afp8q:attempt-1:revision-0:sanguo-scene-outline:0:'

test('a dropped node connection re-attaches to the same request instead of failing the paid run',async()=>{
 const done=harness({error:'Failed to fetch'},{value:{status:200,body:{ok:true}}});
 const result=await requestNodeJson('/api/node-run',{prompt:'x'},KEY,{send:done.send,wait:done.wait});
 assert.deepEqual(result,{status:200,body:{ok:true}});assert.equal(done.calls.length,2,'断连后必须重发一次');assert.deepEqual(done.waits,[3000]);
});

test('a truncated success body never reaches the workflow as a completed node',async()=>{
 for(const value of [undefined,{},{status:undefined},{body:{result:'x'}}]){
  const done=harness({value},{value:{status:200,body:{ok:true}}});
  assert.deepEqual(await requestNodeJson('/api/node-run',{},KEY,{send:done.send,wait:done.wait}),{status:200,body:{ok:true}});
  assert.equal(done.calls.length,2);
 }
 const exhausted=harness({value:{}});
 await assert.rejects(()=>requestNodeJson('/api/node-run',{},KEY,{send:exhausted.send,wait:exhausted.wait,retries:1}),/NODE_RESPONSE_INCOMPLETE/);
 assert.equal(exhausted.calls.length,2,'不完整响应属于可重试事件，用尽预算才报错');
});

test('a real reviewer verdict reaches the gate once and is never silently repeated',async()=>{
 for(const error of ['REVIEW_RESULT_INVALID: 叙事报告 缺少独立结论','HISTORY_DRAMA_INVALID: characterStates 必须覆盖全部场内人物','HTTP 429 Too Many Requests','分镜修复未通过（3 次）']){
  const done=harness({error});
  await assert.rejects(()=>requestNodeJson('/api/builtin-node-run',{},KEY,{send:done.send,wait:done.wait}),{message:error});
  assert.equal(done.calls.length,1,error);assert.deepEqual(done.waits,[]);
 }
 assert.equal(droppedNodeRequest(Error('TypeError: Failed to fetch')),true);
 assert.equal(droppedNodeRequest(Error('socket hang up')),true);
 assert.equal(droppedNodeRequest(Error('read ECONNRESET')),true);
 assert.equal(droppedNodeRequest(Error('Load failed')),true);
 assert.equal(droppedNodeRequest(Error('500 Internal Server Error: upstream JSON parse failed')),false,'上游报错不能靠重发再买一次');
});

test('provider stop metadata survives an HTTP error and overrides misleading network words', async () => {
 const originalFetch=globalThis.fetch;
 let calls=0;
 const body={error:{type:'MODEL_CONTENT_REJECTED',message:'Failure to pass the risk control system; NetworkError',retryable:false},task_id:'paid-rejected-task',provider_response:{data:{task_status:'failed'}}};
 try{
  globalThis.fetch=async()=>{calls++;return Response.json({body},{status:422})};
  await assert.rejects(requestNodeJson('/api/node-run',{},KEY,{wait:async()=>assert.fail('provider rejection cannot retry')}),error=>{
   assert.ok(error instanceof Error);assert.match(error.message,/MODEL_CONTENT_REJECTED/);assert.match(error.message,/paid-rejected-task/);
   assert.equal(modelRetryStopped(error.message),true);assert.equal(droppedNodeRequest(error),false);return true;
  });
  assert.equal(calls,1);
 }finally{globalThis.fetch=originalFetch}
 assert.equal(droppedNodeRequest(Error('MODEL_CONTENT_REJECTED: Failed to fetch')),false);
 assert.equal(droppedNodeRequest(Error('HTTP 502: {"error":"NetworkError","retryable":false}')),false);
});

test('retries stop at the budget and only keyed requests are repeated',async()=>{
 const failing=harness({error:'Failed to fetch'});
 await assert.rejects(()=>requestNodeJson('/api/node-run',{},KEY,{send:failing.send,wait:failing.wait}),/Failed to fetch/);
 assert.equal(failing.calls.length,NODE_REQUEST_RETRIES+1);assert.equal(failing.calls.length,5);assert.deepEqual(failing.waits,Array.from({length:4},(_,i)=>(i+1)*3000));
 const unkeyed=harness({error:'Failed to fetch'});
 await assert.rejects(()=>requestNodeJson('/api/code-node-run',{},undefined,{send:unkeyed.send,wait:unkeyed.wait}),/Failed to fetch/);
 assert.equal(unkeyed.calls.length,1,'无 requestKey 的调用没有去重保障，重发可能二次付费');
});

test('a keyed node response can recover on its fifth identical request and never waits beyond a minute', async () => {
 const payload = Object.freeze({prompt:'same generation',executionContext:{requestKey:KEY}}), waits:number[]=[];
 let calls=0;
 const result=await requestNodeJson('/api/node-run',payload,KEY,{send:async(url,body)=>{
  calls++;assert.equal(url,'/api/node-run');assert.equal(body,payload);
  if(calls<5)throw Error(calls%2?'Failed to fetch':'NODE_RESPONSE_INCOMPLETE: truncated');
  return {status:200,body:{ok:true}};
 },wait:async(ms)=>{waits.push(ms)}});
 assert.deepEqual(result,{status:200,body:{ok:true}});assert.equal(calls,5);assert.equal(waits.length,4);assert.ok(waits.every(ms=>ms<=60000));
});

test('extra-retry overrides remain bounded from zero to four and never make an unkeyed request repeat', async () => {
 for(const [retries,total] of [[0,1],[1,2],[-1,1],[1.9,2],[4,5],[5,5],[19,5],[1000,5],[Infinity,5],[-Infinity,1],[NaN,5]]){
  const failing=harness({error:'Failed to fetch'});
  await assert.rejects(requestNodeJson('/api/node-run',{},KEY,{send:failing.send,wait:failing.wait,retries}),/Failed to fetch/);
  assert.equal(failing.calls.length,total,`extra retries=${retries}`);assert.equal(failing.waits.length,total-1);
 }
 for(const key of [undefined,'',' ']){
  const failing=harness({error:'Failed to fetch'});
  await assert.rejects(requestNodeJson('/api/node-run',{},key,{send:failing.send,wait:failing.wait,retries:1000}),/Failed to fetch/);
  assert.equal(failing.calls.length,1);assert.deepEqual(failing.waits,[]);
 }
});
