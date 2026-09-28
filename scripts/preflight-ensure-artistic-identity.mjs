#!/usr/bin/env node
// Follows the real ensure selector through its saved DB rows and offline face
// anchor, then intercepts the would-be paid image request before submission.
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'

const workflowId = 'wf-sanguo-history-drama'
const directory = path.resolve('logs/dramatic-expression/live-20260928/artistic-identity-migration')
const cases = [
  { name: '张飞', assetId: 'character-mukn7n7k-xzu2tb', episodeNumber: 610,
    visualContext: { version: 'character-visual-context-v1', age: { stage: 'mature', basis: 'artistic', asOf: '张飞释严颜（215—219），确切生年未知' },
      look: { key: 'jiangzhou-command-v1', description: '江州行军统兵时的稳定汉末袍甲' },
      appearanceConstraints: { hair: 'dark', facialHair: 'dark', build: '宽肩骨架，英俊威武、健康偏白' } } },
  { name: '刘备', assetId: 'character-mukn7n96-esdd71', episodeNumber: 693,
    visualContext: { version: 'character-visual-context-v1', age: { stage: 'mature', basis: 'artistic', asOf: '伐吴之前；确切生年未在本次证据中确认' },
      look: { key: 'pre-east-campaign-command-v1', description: '东征前统兵时的稳定汉末袍服' },
      appearanceConstraints: { hair: 'dark', facialHair: 'dark', build: '身形匀称，端正俊朗、健康偏白' } } },
]
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc', options: '-c default_transaction_read_only=on' })
try {
  await fs.mkdir(directory, { recursive: true })
  const proof = []
  for (const item of cases) {
    let captured
    try {
      await executeBuiltinNode(pool, { operation: 'character.ensure', model: { id: 'blocked-image-preflight', provider: 'Kling', capability: 'image', settings: {} },
        params: { workflowId, episodeNumber: item.episodeNumber, characters: [{ name: item.name, visualContext: item.visualContext }],
          deferArchive: true, qualityDisposition: 'manual-review-v1', validateThreeView: false, maxGenerationAttempts: 1 } },
      async request => { captured = request; throw Error('OFFLINE_STOP_BEFORE_PAID_IMAGE') })
      throw Error('真实 ensure 未到达被拦截的付费图像请求')
    } catch (error) {
      if (!String(error).includes('OFFLINE_STOP_BEFORE_PAID_IMAGE')) throw error
    }
    const params = captured?.params ?? {}
    if (params.identityReferenceAssetId !== item.assetId || params.identityReferenceRole !== 'facial-identity-only'
      || !params.identityReferenceAnchor || params.identityReferenceAnchor.sourceAssetId !== item.assetId
      || params.referenceImages?.length !== 1 || params.referenceImages[0] !== params.identityReferenceAnchor.anchorUrl
      || !String(captured.prompt).includes('【同一人物的艺术身份，不是史料容貌】')) {
      throw Error(`${item.name} 未在图像付费前绑定当前修订图和隔离脸部锚点`)
    }
    proof.push({ name: item.name, episodeNumber: item.episodeNumber, identityReferenceAssetId: params.identityReferenceAssetId,
      role: params.identityReferenceRole, anchorUrl: params.identityReferenceAnchor.anchorUrl,
      sourceColorPolicy: params.identityReferenceAnchor.colorPolicy, generationPromptHasArtDirection: true,
      newAgeLook: item.visualContext.look.key, providerRequestsSubmitted: 0 })
  }
  await fs.writeFile(path.join(directory, 'ensure-face-source-preflight.json'), JSON.stringify({ status: 'passed', proof }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ status: 'passed', proof }))
} finally { await pool.end() }
