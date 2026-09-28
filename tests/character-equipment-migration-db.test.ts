import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { upgradeCharacterVisualWorkflow } from '../src/character-visual-workflow.ts'
import { SANGUO_CHARACTER_LOOKUP_CODE, SANGUO_FIRST_FRAME_BRANCH_CODE } from '../src/code-node-presets.ts'

const databaseUrl = process.env.CHARACTER_TEST_DATABASE_URL ?? process.env.VOICE_TEST_DATABASE_URL

test('schema-only equipment migration backs up once, preserves custom code and execution rows, then becomes no-op', {skip: !databaseUrl}, async () => {
  const schema = `character_equipment_migration_${randomUUID().replaceAll('-','')}`
  const outputDir = mkdtempSync(join(tmpdir(),'character-equipment-migration-'))
  const admin = new pg.Pool({connectionString:databaseUrl})
  await admin.query(`create schema ${schema}`)
  const isolatedUrl = new URL(databaseUrl as string)
  isolatedUrl.searchParams.set('options',`-c search_path=${schema}`)
  const db = new pg.Pool({connectionString:isolatedUrl.toString()})
  try {
    await db.query(`create table workflow_configs (
      id text primary key, name text not null, description text not null default '',
      nodes jsonb not null default '[]', edges jsonb not null default '[]',
      schema_version integer not null default 1, updated_at timestamptz not null default now()
    )`)
    await db.query('create table execution_records (id text primary key, workflow_id text not null)')
    const nodes = upgradeCharacterVisualWorkflow({id:'wf-sanguo-history-drama',schemaVersion:153,nodes:[
      {id:'sanguo-scene-outline',prompt:'原有大纲提示'},
      {id:'sanguo-shot-script',prompt:'原有分镜提示'},
      {id:'sanguo-character-lookup',prompt:'',code:SANGUO_CHARACTER_LOOKUP_CODE},
      {id:'sanguo-first-frame-branch',prompt:'',code:SANGUO_FIRST_FRAME_BRANCH_CODE},
      {id:'sanguo-video',prompt:'',params:[]},
      {id:'custom-node',prompt:'保留独立节点',code:'return {approved:true}'},
    ]}).nodes
    await db.query('insert into workflow_configs(id,name,nodes,edges,schema_version) values($1,$2,$3::jsonb,$4::jsonb,153)',
      ['wf-sanguo-history-drama','历史剧',JSON.stringify(nodes),'[]'])
    await db.query("insert into execution_records(id,workflow_id) values('run-1','wf-sanguo-history-drama')")
    const run=(apply:boolean) => JSON.parse(execFileSync(process.execPath,
      ['scripts/migrate-character-equipment-workflow.mjs',...(apply?['--apply']:[]),'--out',outputDir],
      {cwd:new URL('..',import.meta.url).pathname,env:{...process.env,DATABASE_URL:isolatedUrl.toString()},encoding:'utf8'}))
    const preview=run(false)
    assert.equal(preview.changedSchema,true)
    assert.deepEqual(preview.changedNodes,[])
    assert.equal(preview.schemaBefore,153)
    assert.equal(preview.targetSchemaVersion,154)
    const applied=run(true)
    assert.equal(applied.schemaAfter,154)
    assert.ok(applied.backupFile)
    assert.equal(JSON.parse(readFileSync(applied.backupFile,'utf8')).schema_version,153)
    const stored=(await db.query("select nodes,schema_version from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
    assert.equal(stored.schema_version,154)
    assert.deepEqual(stored.nodes,nodes)
    assert.equal((await db.query('select count(*)::int as count from execution_records')).rows[0].count,1)
    const repeat=run(true)
    assert.equal(repeat.noOp,true)
    assert.equal(repeat.backupFile,null)
  } finally {
    await db.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
    rmSync(outputDir,{recursive:true,force:true})
  }
})
