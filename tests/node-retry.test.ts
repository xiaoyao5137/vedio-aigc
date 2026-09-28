import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceTransition, type RetryRun } from '../src/node-retry.ts'
import { runWorkflowToCompletion } from '../src/workflow-runner.ts'
import type { StepRunStatus } from '../src/workflow-core.ts'

const run=(id:string,index=0):RetryRun=>({node:{id,kind:id==='generate'?'video':'code',resultVar:id},loopGroupId:'g',loopIndex:index,status:'success',durationMs:10,output:{url:id+'.mp4'},context:{},inputContext:{script:'keep'}})
function fixture(){const runs=[run('previous',-1),run('generate'),run('evidence'),run('review'),run('gate'),run('next',1)];runs[4].node.acceptance={passedPath:'passed',retryFrom:'generate',maxAttempts:4,feedbackPath:'repair'};runs[5].status='idle';return runs}
test('reject rewinds only the configured scope and persists full outputs across JSON checkpoint',()=>{
 const runs=fixture();const result=acceptanceTransition(runs,4,{passed:false,repair:'speak naturally'})!;
 assert.deepEqual(result.runs.map(r=>r.status),['success','idle','idle','idle','idle','idle']);
 assert.equal(result.runs[0],runs[0]);assert.equal(result.runs[5],runs[5]);
 assert.equal(result.runs[1].attempt,2);assert.equal(result.runs[1].retryFeedback,'speak naturally');assert.equal(result.runs[3].retryFeedback,undefined);assert.equal(result.runs[4].retryFeedback,undefined);
 const saved=JSON.parse(JSON.stringify(result.runs));assert.equal(saved[1].attempts[0].output.url,'generate.mp4');assert.equal(saved[4].attempts[0].output.repair,'speak naturally');
 assert.deepEqual(result.context,{script:'keep'});assert.equal(runs[1].status,'success');
})
test('accept passes once; missing, unknown and cross-loop decisions never purchase another take',()=>{
 const runs=fixture();assert.equal(acceptanceTransition(runs,4,{passed:true}),undefined);
 assert.throws(()=>acceptanceTransition(runs,4,{}),/REVIEW_RESULT_INVALID/);
 runs[4].node.acceptance!.retryFrom='previous';assert.throws(()=>acceptanceTransition(runs,4,{passed:false}),/RETRY_CONFIG_INVALID/);
 runs[4].node.acceptance!.maxAttempts=Infinity;assert.throws(()=>acceptanceTransition(runs,4,{passed:false}),/RETRY_CONFIG_INVALID/);
})
test('full run retries three rejected takes, accepts the fourth and then advances',async()=>{
 type State={nodeRuns:Array<RetryRun & {status:StepRunStatus}>};const f=fixture().slice(1);f.forEach(r=>r.status='idle');
 let purchases=0;const state:State={nodeRuns:f as State['nodeRuns']};
 const done=await runWorkflowToCompletion(state,async(i,state)=>{
   const runs=state.nodeRuns.map((r,j)=>j===i?{...r,status:'success' as const}:r);
   if(runs[i].node.id==='generate')purchases++;
   const t=acceptanceTransition(runs,i,{passed:purchases===4,repair:'specific feedback'});
   return {nodeRuns:(t?.runs??runs) as State['nodeRuns']};
 });
 assert.equal(purchases,4);assert.equal(done.nodeRuns.at(-1)!.status,'success');assert.equal(done.nodeRuns[0].attempts!.length,3);
})
test('exhaustion retains rejected output and prevents every downstream step',()=>{
 const runs=fixture().map(r=>({...r,attempt:4}));const t=acceptanceTransition(runs,4,{passed:false,repair:'still slow'})!;
 assert.equal(t.exhausted,true);assert.equal(t.runs[4].status,'failed');assert.deepEqual(t.runs[4].output,{passed:false,repair:'still slow'});assert.equal(t.runs[5].status,'idle');
})

test('reviewer failures retry only review with a separate budget and fresh request revision',async()=>{
 const {errorRetryTransition}=await import('../src/node-retry.ts');
 const runs=fixture().map(r=>({...r,node:{...r.node,errorRetry:undefined as import('../src/node-retry.ts').ErrorRetryPolicy|undefined},revision:0,errorAttempt:1,attempt:3}));
 runs[4].node.errorRetry={retryFrom:'review',maxAttempts:2,patterns:['REVIEW_RESULT_INVALID:']};
 const recovery=errorRetryTransition(runs,4,'REVIEW_RESULT_INVALID: missing evidence')!;
 assert.equal(recovery.index,3);assert.equal(recovery.runs[1],runs[1]);assert.equal(recovery.runs[1].output,runs[1].output);
 assert.equal(recovery.runs[3].attempt,3);assert.equal(recovery.runs[3].revision,1);assert.equal(recovery.runs[4].errorAttempt,2);
 const resumed=JSON.parse(JSON.stringify(recovery.runs));const exhausted=errorRetryTransition(resumed,4,'REVIEW_RESULT_INVALID: still uncertain')!;
 assert.equal(exhausted.exhausted,true);assert.equal(exhausted.runs[4].status,'failed');
 assert.equal(errorRetryTransition(runs,4,'HTTP 401 invalid credential'),undefined);
})
