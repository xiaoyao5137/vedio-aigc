import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { mergeCharacterBiographyEvidence } from '../src/character-biography.ts'
import { enrichCharactersWithHistoricalPortraits } from '../server/builtin-nodes.ts'
import { upgradeCharacterBiographyWorkflow } from '../src/character-biography-workflow.ts'

const workflowId = 'wf-sanguo-history-drama'
const characterName = '张飞'
const sourceExecutionId = 'record-610-tail-adopt-20260928-v1'
const apply = process.argv.includes('--apply')
const option = (name) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? '' : process.argv[index + 1] ?? ''
}
const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const client = await pool.connect()
let committed = false
try {
  await client.query('begin transaction isolation level repeatable read')
  const workflow = (await client.query(`select id,name,description,nodes,edges,schema_version,updated_at
    from workflow_configs where id=$1 for update`, [workflowId])).rows[0]
  const profile = (await client.query(`select workflow_id,character_name,biography,updated_at
    from character_biographies where workflow_id=$1 and character_name=$2 for update`, [workflowId, characterName])).rows[0]
  const asset = (await client.query(`select id,metadata->>'biography' as biography from character_assets
    where workflow_id=$1 and character_name=$2 and metadata ? 'biography' order by created_at desc limit 1`,
    [workflowId, characterName])).rows[0]
  const execution = (await client.query(`select id,result from execution_records where id=$1`, [sourceExecutionId])).rows[0]
  if (!workflow || !profile || !execution) throw Error('迁移所需工作流、人物档案或原执行记录缺失')
  const decoded = decodeExecutionState(execution.result)
  const knownSources = decoded.nodeRuns
    .map(run => run.context?.historical_sources)
    .find(sources => Array.isArray(sources?.citations)
      && sources.citations.some(citation => citation.title === '三國志/卷36#張飛'))
  if (!knownSources) throw Error('原执行记录不含已核对的《三國志/卷36#張飛》引用')
  const portrait = await enrichCharactersWithHistoricalPortraits([{ name: characterName }], async () => {
    throw Error('迁移必须仅复用已保存史料，不得发起网络检索或模型调用')
  }, {}, { knownSources: [knownSources] })
  const enriched = portrait.characters[0]
  if (enriched.historicalPortrait.status !== 'found' || !enriched.biography?.includes('飛雄壯威猛')) {
    throw Error('原史料未产生可核对的体貌引文，停止迁移')
  }
  if (asset?.biography !== profile.biography) throw Error('人物自传与当前自动归档版本不一致，可能有人工编辑；停止自动回填')
  const merged = mergeCharacterBiographyEvidence(profile.biography, enriched.biography)
  if (!merged) throw Error('现有人物自传没有可自动补全的原始占位段，停止回填')
  const nextWorkflow = upgradeCharacterBiographyWorkflow({
    id: workflow.id, schemaVersion: workflow.schema_version, nodes: workflow.nodes,
  })
  const oldNode = workflow.nodes.find(node => node.id === 'sanguo-character-portrait')
  const newNode = nextWorkflow.nodes.find(node => node.id === 'sanguo-character-portrait')
  const alreadyUpgraded = Boolean(oldNode) && workflow.schema_version === 155 && oldNode.runIf === undefined
    && oldNode.params.some(param => param.englishName === 'historicalSources' && param.value === '${historical_sources}')
    && oldNode.prompt.includes('对本镜具名人物补充可核对的正史生平与体貌资料')
  if (!oldNode || !newNode || nextWorkflow.schemaVersion !== 155 || oldNode === newNode && !alreadyUpgraded) {
    throw Error('当前工作流不符合受控 schema 154→155 升级条件')
  }
  const oldWorkflowHash = sha256(workflow.nodes)
  const oldBiographyHash = sha256(profile.biography)
  const preview = {
    mode: apply ? 'apply' : 'preview', workflowId, sourceExecutionId,
    workflow: { schemaBefore: workflow.schema_version, schemaAfter: nextWorkflow.schemaVersion,
      alreadyUpgraded, lastSavedAt: workflow.updated_at,
      nodeCountBefore: workflow.nodes.length, nodeCountAfter: nextWorkflow.nodes.length,
      oldNodesSha256: oldWorkflowHash, newNodesSha256: sha256(nextWorkflow.nodes),
      changedNodeIds: workflow.nodes.filter((node, index) => JSON.stringify(node) !== JSON.stringify(nextWorkflow.nodes[index])).map(node => node.id),
      portraitChanges: { runIfBefore: oldNode.runIf ?? null, runIfAfter: newNode.runIf ?? null,
        addedParams: newNode.params.filter(param => !oldNode.params.some(previous => previous.id === param.id)).map(param => param.englishName),
        promptChanged: oldNode.prompt !== newNode.prompt },
    },
    biography: { name: characterName, oldSha256: oldBiographyHash, newSha256: sha256(merged),
      oldLength: profile.biography.length, newLength: merged.length,
      sourceUrls: [...new Set(enriched.historicalPortrait.citations.map(citation => citation.url))],
      retainedDesign: merged.includes(profile.biography.split('【当前剧作外观设定】')[1] ?? '<<missing>>'),
      expectedAssetMetadataMatch: asset.id },
  }
  if (!apply) {
    console.log(JSON.stringify(preview, null, 2))
    await client.query('rollback')
  } else {
    if (option('--expected-workflow-sha256') !== oldWorkflowHash
      || option('--expected-biography-sha256') !== oldBiographyHash) {
      throw Error('必须提供与预览完全一致的两个旧值 SHA-256，防止并发修改')
    }
    const backupDir = join(process.cwd(), 'logs', 'character-biography-repair-20260928')
    await mkdir(backupDir, { recursive: true })
    const backupPath = join(backupDir, `before-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify({ workflow, profile, asset, sourceExecutionId,
      sourceCitation: knownSources.citations.find(citation => citation.title === '三國志/卷36#張飛') }, null, 2))
    const updatedWorkflow = alreadyUpgraded ? { rowCount: 1 } : await client.query(`update workflow_configs set nodes=$2::jsonb,schema_version=$3,updated_at=now()
      where id=$1 and nodes=$4::jsonb and schema_version=$5 returning id`,
    [workflowId, JSON.stringify(nextWorkflow.nodes), nextWorkflow.schemaVersion, JSON.stringify(workflow.nodes), workflow.schema_version])
    const updatedProfile = await client.query(`update character_biographies set biography=$3,updated_at=now()
      where workflow_id=$1 and character_name=$2 and biography=$4 returning character_name`,
    [workflowId, characterName, merged, profile.biography])
    if (updatedWorkflow.rowCount !== 1 || updatedProfile.rowCount !== 1) throw Error('并发修改保护未通过')
    await client.query('commit')
    committed = true
    console.log(JSON.stringify({ ...preview, backupPath, committed: true }, null, 2))
  }
} catch (error) {
  if (!committed) await client.query('rollback').catch(() => {})
  throw error
} finally {
  client.release()
  await pool.end()
}
