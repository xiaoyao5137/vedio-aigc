import test from 'node:test'
import assert from 'node:assert/strict'
import { executeCodeNode } from '../server/code-node.ts'
import { migrateBranchWorkflow } from '../src/branch-migration.ts'
import { branchConfigurationErrors, branchDecision, branchRunContext, executionRouteEdges, orderRouteNodes, retryBranchRun, routeBranch, setBranchEdge, type BranchRun } from '../src/workflow-branch.ts'
import { runWorkflowToCompletion } from '../src/workflow-runner.ts'
import { applyNodeOutputToContext } from '../src/workflow-core.ts'
const node = (id: string, kind = 'code') => ({ id, title: id, kind, resultVar: id, code: 'return {};', prompt: '', position: { x: 0, y: 0 }, params: [] as Array<{id:string;name:string;englishName?:string;type:string;value:string;required:boolean}> })
const run = (id: string, kind = 'code'): BranchRun => ({ id, node: node(id, kind), status: 'idle', durationMs: 0, context: {}, inputContext: {} })
const edge = (from: string, to: string, branch?: 'true'|'false') => ({ id: `${from}-${to}-${branch??''}`, from, to, ...(branch !== undefined ? { branch } : {}) })

test('user-owned true/false edges can be added, replaced, removed, duplicated to same target and persisted', () => {
 let edges = setBranchEdge([], 'b','true','x','one')
 edges = setBranchEdge(edges,'b','false','x','two')
 assert.equal(edges.length,2)
 edges = setBranchEdge(edges,'b','true','b','self')
 assert.equal(edges.find(e=>e.branch==='true')!.to,'b')
 assert.deepEqual(JSON.parse(JSON.stringify(edges)),edges)
 assert.equal(setBranchEdge(edges,'b','false','','remove').length,1)
})
test('branch boolean results are strict; real VM boolean envelopes are supported', async () => {
 assert.equal(branchDecision(await executeCodeNode({code:'return false;'})),false)
 assert.equal(branchDecision(await executeCodeNode({code:'return {value:true};'})),true)
 for(const output of ['false',{},null,{value:0}]) assert.throws(()=>branchDecision(output),/BRANCH_RESULT_INVALID/)
})
test('ordering distinguishes routing cycles from invalid ordinary dependency cycles, including an appended branch', () => {
 const w={nodes:[node('input'),node('gen'),node('gate'),node('done'),node('b','branch')],edges:[edge('input','gen'),edge('gen','gate'),edge('gate','b'),edge('b','done','true'),edge('b','gen','false')]}
 assert.deepEqual(orderRouteNodes(w).ordered.map(n=>n.id),['input','gen','gate','b','done'])
 assert.equal(executionRouteEdges(w).length,4)
 assert.deepEqual(branchConfigurationErrors(w),[])
 assert.match(branchConfigurationErrors({...w,edges:[...w.edges,edge('gate','gen')]}).join(),/普通依赖/)
})
test('forward true/false arms skip the unselected branch but retain the shared merge', () => {
 const w={nodes:[node('b','branch'),node('yes'),node('no'),node('merge')],edges:[edge('b','yes','true'),edge('b','no','false'),edge('yes','merge'),edge('no','merge')]}
 for(const decision of [true,false]) {
 const runs=w.nodes.map(n=>({...run(n.id,n.kind),node:n}))
 const result=routeBranch(w,runs,0,{value:decision},{input:'keep'})
 assert.equal(result.runs.find(r=>r.node.id===(decision?'no':'yes'))!.status,'skipped')
 assert.equal(result.runs.find(r=>r.node.id==='merge')!.status,'idle')
 assert.equal(result.runs[result.index].node.id,decision?'yes':'no')
 assert.equal(result.runs[result.index].routeInputContext!.input,'keep')
 }
})
test('branch context patches cannot overwrite a validation result on a forward or rewind route', () => {
 const w={nodes:[node('review','validation'),node('b','branch'),node('done')],
  edges:[edge('review','b'),edge('b','done','true'),edge('b','review','false')]}
 const runs=w.nodes.map(n=>({...run(n.id,n.kind),node:n}))
 const inputContext={review:{passed:true}}
 for(const value of [true,false]) assert.throws(()=>routeBranch(w,runs,1,
  {value,contextPatch:{review:{passed:false}}},inputContext),/VALIDATION_RESULT_CONTEXT_PATCH_CONFLICT/)
 assert.deepEqual(inputContext.review,{passed:true})
})
test('backward routing supports unrelated nodes, self and cross-loop nodes; fresh revisions and evidence survive', () => {
 const w={nodes:[node('unrelated'),node('b','branch'),node('done')],edges:[edge('b','unrelated','false'),edge('b','done','true')]}
 const runs=[{...run('unrelated'),status:'success',output:{expensive:'old'},inputContext:{seed:1}}, {...run('b','branch'),status:'running',loopGroupId:'L',loopIndex:2},run('done')]
 const result=routeBranch(w,runs,1,{value:false,feedback:'fix'},{})
 assert.equal(result.index,0);assert.equal(result.runs[0].revision,1)
 assert.equal(result.runs[0].retryFeedback,'fix');assert.equal(result.runs[0].routeInputContext!.seed,1)
 assert.equal(result.runs[1].branchState!.counts.false,1)
 assert.equal(JSON.parse(JSON.stringify(result.history)).runs[0].output.expensive,'old')
 const self=routeBranch({...w,edges:[edge('b','b','false'),edge('b','done','true')]},runs,1,false,{})
 assert.equal(self.index,1);assert.equal(self.runs[1].status,'idle')
})

test('generic migration produces explicit nodes and real edges once; no legacy policies remain', () => {
 const gate={...node('gate'),acceptance:{passedPath:'passed',retryFrom:'gen',maxAttempts:2,feedbackPath:'issues'},errorRetry:{retryFrom:'review',maxAttempts:3,patterns:['INVALID']}}
 const w={nodes:[node('gen'),node('review'),gate,node('done')],edges:[edge('gen','review'),edge('review','gate'),edge('gate','done')]}
 const migrated=migrateBranchWorkflow(w)
 assert.equal(migrated.nodes.filter(n=>n.kind==='branch').length,2)
 assert.equal(migrated.nodes.some(n=>n.acceptance||n.errorRetry),false)
 assert.deepEqual(branchConfigurationErrors(migrated),[])
 assert.deepEqual(orderRouteNodes(migrated).ordered.map(n=>n.id),['gen','review','gate','gate-error-branch','gate-accept-branch','done'])
 assert.equal(migrateBranchWorkflow(migrated),migrated)
})

test('real code stops on branch budget, checkpoint restores, editing limit retries only branch then completes', async () => {
 const w=migrateBranchWorkflow({nodes:[node('gen'),{...node('gate'),code:'return {passed:context.gen.take>=3,issues:["fix"]};',acceptance:{passedPath:'passed',retryFrom:'gen',maxAttempts:2,feedbackPath:'issues'}},node('done')],edges:[edge('gen','gate'),edge('gate','done')]})
 type R=BranchRun & {status:'idle'|'running'|'success'|'failed'|'skipped';node:typeof w.nodes[number]}
 type State={nodeRuns:R[];context:Record<string,unknown>;history:unknown[]}
 let purchases=0
 const calls:string[]=[]
 let state:State={nodeRuns:orderRouteNodes(w).ordered.map(n=>({...run(n.id,n.kind),node:n,status:'idle'})),context:{},history:[]}
 const execute=async(index:number,state:State):Promise<State>=>{
 const r=state.nodeRuns[index]; calls.push(r.node.id)
 const context=branchRunContext(r,r.routeInputContext??state.nodeRuns.slice(0,index).filter(r=>r.status==='success').at(-1)?.context??{})
 const params=Object.fromEntries(r.node.params.map(p=>[p.englishName??p.name,p.type==='number'?Number(r.paramOverrides?.[p.id]??p.value):r.paramOverrides?.[p.id]??p.value]))
 const runs=state.nodeRuns.map((r,i)=>i===index?{...r,inputContext:context,status:'running' as const}:r)
 try{
 const output=r.node.id==='gen'?{take:++purchases}:await executeCodeNode({code:r.node.code!,params,context})
 if(r.node.kind==='branch'){const t=routeBranch(w,runs,index,output,context);return{nodeRuns:t.runs as R[],context:t.context,history:[...state.history,t.history]}}
 const next=applyNodeOutputToContext(context,r.node.resultVar,output)
 return {...state,nodeRuns:runs.map((r,i)=>i===index?{...r,status:'success',output,context:next}:r),context:next}
 }catch(error){return {...state,nodeRuns:runs.map((r,i)=>i===index?{...r,status:'failed',error:String(error),context}:r)}}
 }
 state=await runWorkflowToCompletion(state,execute)
 const index=state.nodeRuns.findIndex(r=>r.status==='failed')
 assert.equal(state.nodeRuns[index].node.kind,'branch');assert.equal(purchases,2)
 assert.equal(state.nodeRuns[index].branchState!.counts.false,1)
 state=JSON.parse(JSON.stringify(state))
 const limit=state.nodeRuns[index].node.params.find(p=>p.name==='maxAttempts')!
 state.nodeRuns[index].paramOverrides={[limit.id]:'4'}
 state.nodeRuns=retryBranchRun(state.nodeRuns,index)
 state=await execute(index,state)
 assert.equal(purchases,2,'manual branch retry must not submit a generator')
 assert.equal(state.nodeRuns[0].status,'idle')
 state=await runWorkflowToCompletion(state,execute)
 assert.equal(purchases,3);assert.equal(state.nodeRuns.at(-1)!.status,'success')
 assert.equal(state.nodeRuns.find(r=>r.node.kind==='branch')!.branchState!.counts.false,2)
 assert.equal(calls.filter(id=>id==='gate-accept-branch').length,4)
})

test('a jump to a loop owner discards expanded execution slots, preserves evidence and carries the deciding branch budget', () => {
 const loop={...node('loop','loop'),childIds:['gen','b'],loop:{enabled:true}}
 const w={nodes:[loop,node('gen'),node('b','branch'),node('done')],edges:[edge('loop','gen'),edge('gen','b'),edge('b','done','true'),edge('b','loop','false')]}
 const runs=[{...run('loop','loop'),node:loop,status:'success'}, {...run('gen'),status:'success',output:{paid:'video'},loopNode:loop,loopGroupId:'old',loopIndex:0}, {...run('b','branch'),loopNode:loop,loopGroupId:'old',loopIndex:0,status:'running',paramOverrides:{limit:'5'}},run('done')]
 const t=routeBranch(w,runs,2,false,{})
 assert.deepEqual(t.runs.map(r=>r.node.id),['loop','done'])
 assert.equal(t.runs[0].branchCarry!.b.state.counts.false,1)
 assert.equal(t.runs[0].branchCarry!.b.paramOverrides!.limit,'5')
 assert.equal(t.history.runs.find(r=>r.nodeId==='gen')!.output!.paid,'video')
})

test('forward entry to an unexpanded loop child initializes its owner with a visible entry target', () => {
 const loop={...node('loop','loop'),childIds:['a','b'],loop:{enabled:true}}
 const w={nodes:[node('branch','branch'),loop,node('a'),node('b'),node('done')],edges:[edge('branch','b','true'),edge('branch','done','false'),edge('loop','a'),edge('a','b'),edge('b','done')]}
 const runs=w.nodes.map(n=>({...run(n.id,n.kind),node:n}))
 const t=routeBranch(w,runs,0,true,{seed:'keep'})
 assert.equal(t.runs[t.index].node.id,'loop')
 assert.equal(t.runs[t.index].branchEntryTarget,'b')
 assert.equal(t.runs[t.index].routeInputContext!.seed,'keep')
})

test('legacy failed checkpoint gains a blocked branch while retaining paid outputs and original attempt counts', async () => {
 const {migrateBranchRuns}=await import('../src/branch-migration.ts')
 const gate={...node('gate'),acceptance:{passedPath:'passed',retryFrom:'gen',maxAttempts:3,feedbackPath:'issues'}}
 const w={nodes:[node('gen'),gate,node('done')],edges:[edge('gen','gate'),edge('gate','done')]}
 const nodes=migrateBranchWorkflow(w)
 const runs=[{...run('gen'),node:w.nodes[0],status:'success',output:{url:'paid.mp4'},context:{gen:{url:'paid.mp4'}}},{...run('gate'),node:gate,status:'failed',output:{passed:false},attempt:3,error:'exhausted',context:{gen:{url:'paid.mp4'}}},{...run('done'),node:w.nodes[2]}]
 const migrated=migrateBranchRuns(nodes,runs)
 assert.equal(migrated[0].output,runs[0].output)
 assert.equal(migrated[1].status,'success')
 assert.equal(migrated[2].status,'failed')
 assert.equal(migrated[2].branchState!.counts.false,2)
 assert.equal(runs[1].status,'failed')
 assert.equal(migrateBranchRuns(nodes,migrated),migrated)
})

test('empty loop children remain routable through their owner and carry code context patches into re-expansion', () => {
 const loop={...node('loop','loop'),childIds:['child'],loop:{enabled:true}}
 const w={nodes:[loop,node('child'),node('b','branch'),node('done')],edges:[edge('loop','child'),edge('child','b'),edge('b','child','false'),edge('b','done','true')]}
 const runs=[{...run('loop','loop'),node:loop,status:'success',inputContext:{items:[]}}, {...run('b','branch'),status:'running'},run('done')]
 const t=routeBranch(w,runs,1,{value:false,contextPatch:{items:['new']}},{})
 assert.equal(t.index,0)
 assert.equal(t.runs[0].branchEntryTarget,'child')
 assert.deepEqual(t.runs[0].routeInputContext!.items,['new'])
})

test('migrated quality exceptions are outputs; editable error branch code decides repair budget', async () => {
 const gate={...node('gate'),code:'throw Error("INVALID: missing report");',errorRetry:{retryFrom:'review',maxAttempts:2,patterns:['INVALID:']}}
 const w=migrateBranchWorkflow({nodes:[node('review'),gate,node('done')],edges:[edge('review','gate'),edge('gate','done')]})
 const output=await executeCodeNode({code:w.nodes.find(n=>n.id==='gate')!.code!})
 assert.equal(output.routeError,'INVALID: missing report')
 const b=w.nodes.find(n=>n.kind==='branch')!
 const params={maxAttempts:2,patterns:['INVALID:']}
 const context={gate:output,branch:{visits:0,counts:{true:0,false:0}}}
 assert.equal(branchDecision(await executeCodeNode({code:b.code!,params,context})),false)
 context.branch.counts.false=1
 await assert.rejects(()=>executeCodeNode({code:b.code!,params,context}),/异常复核达到上限/)
 assert.equal(branchDecision(await executeCodeNode({code:b.code!,params:{...params,maxAttempts:3},context})),false)
})

test('manually re-evaluating a successful branch invalidates completed successors before following its new edge', () => {
 const w={nodes:[node('b','branch'),node('a'),node('z')],edges:[edge('b','a','true'),edge('b','z','false'),edge('a','z')]}
 const runs=[{...run('b','branch'),status:'success'},{...run('a'),status:'success',output:{old:1}}, {...run('z'),status:'success',output:{old:2}}]
 const reset=retryBranchRun(runs,0)
 const t=routeBranch(w,reset,0,true,{seed:1})
 assert.equal(t.runs[1].status,'idle');assert.equal(t.runs[2].status,'idle')
 assert.equal(t.runs[1].revision,1);assert.equal(t.runs[1].output,undefined)
 assert.equal(t.history.runs.length,2)
})

test('a manually added branch can join and leave an explicit loop without hidden membership returning', async () => {
 const {setBranchLoop}=await import('../src/workflow-branch.ts')
 const {scopedLoopNodes}=await import('../src/workflow-core.ts')
 const w={nodes:[{...node('loop','loop'),childIds:[] as string[]},node('b','branch'),node('done')],edges:[edge('loop','b'),edge('b','done','true'),edge('b','b','false')]}
 const inside=setBranchLoop(w,'b','loop')
 assert.deepEqual(scopedLoopNodes(inside,'loop',inside.nodes).map(n=>n.id),['b'])
 assert.equal(inside.nodes.find(n=>n.id==='b')!.parentId,'loop')
 const outside=setBranchLoop(inside,'b','')
 assert.deepEqual(scopedLoopNodes(outside,'loop',outside.nodes),[])
 assert.equal(outside.nodes.find(n=>n.id==='b')!.parentId,undefined)
})

test('rewind keeps a complete independent scene for round inspection and persistence', () => {
 const w={nodes:[node('gen'),node('b','branch'),node('done')],edges:[edge('b','gen','false'),edge('b','done','true')]}
 const runs=[{...run('gen'),status:'success',output:{text:'first'},inputs:{seed:1},context:{gen:{text:'first'}},attempts:[{output:'older'}]},run('b','branch'),run('done')]
 const first=routeBranch(w,runs,1,{value:false},{gen:{text:'first'}})
 const scene=JSON.parse(JSON.stringify(first.history)).scene
 assert.equal(scene.length,3)
 assert.equal(scene[0].node.title,'gen')
 assert.deepEqual(scene[0].inputs,{seed:1})
 assert.deepEqual(scene[0].context,{gen:{text:'first'}})
 assert.equal(scene[1].status,'success')
 assert.equal(scene[1].branchState.counts.false,1)
 assert.equal(scene[2].status,'idle')
 assert.equal(scene[0].attempts,undefined)
 runs[0].output.text='mutated'
 assert.deepEqual(first.history.scene![0].output,{text:'first'})
 const second=routeBranch(w,first.runs.map((r,i)=>i===0?{...r,status:'success',output:{text:'second'}}:r),1,false,{})
 assert.deepEqual(second.history.scene![0].output,{text:'second'})
 assert.deepEqual(first.history.scene![0].output,{text:'first'})
 assert.equal(routeBranch(w,second.runs,1,true,{}).history.scene,undefined)
})

test('conditional quality gates pass their skip condition to both migrated branches',()=>{
 const condition={path:'lookup.shouldGenerate',equals:true};
 const gate={...node('gate'),runIf:condition,acceptance:{passedPath:'passed',retryFrom:'gen',maxAttempts:3},errorRetry:{retryFrom:'review',maxAttempts:2,patterns:['INVALID:']}};
 const w=migrateBranchWorkflow({nodes:[node('gen'),node('review'),gate,node('done')],edges:[edge('gen','review'),edge('review','gate'),edge('gate','done')]});
 const branches=w.nodes.filter(n=>n.kind==='branch') as Array<typeof gate>;
 assert.equal(branches.length,2);for(const branch of branches)assert.deepEqual(branch.runIf,condition);
});
