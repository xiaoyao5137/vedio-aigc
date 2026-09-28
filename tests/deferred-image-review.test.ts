import test from 'node:test'
import assert from 'node:assert/strict'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import type { Pool } from 'pg'

test('deferred review returns image candidates without implicit quality calls or asset writes',async()=>{
 const queries:string[]=[];const pool={query:async(sql:string)=>{queries.push(sql);return {rows:[]}}} as unknown as Pool;
 let calls=0;
 const result=await executeBuiltinNode(pool,{operation:'character.ensure',params:{characters:[{name:'测试人物',description:'灰袍无须',designPrompt:'中性站姿'}],workflowId:'test-generic-image',validateThreeView:false,deferArchive:true,generationPromptTemplate:'{{character.name}}：{{character.description}}，修复{{feedback}}',retryFeedback:'不持道具'},model:{id:'test-image',provider:'Kling',capability:'image',settings:{}}},async request=>{
  calls++;assert.match(request.prompt,/测试人物：灰袍无须，修复不持道具/);return {status:200,body:{url:'https://example.test/candidate.png'}};
 });
 assert.equal(calls,1);assert.equal((result as {items:unknown[]}).items.length,1);assert.ok(queries.every(q=>!/^\s*(insert|update)/i.test(q)));
})
