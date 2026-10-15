import { Pool } from 'pg'
import { DEFAULT_BRANCH_CODE } from '../src/workflow-branch.ts'
import { GENERIC_STORY_SCRIPT_PROMPT } from '../src/generic-story-script-prompt.ts'

const workflowId = 'wf-workplace-second-trial-v1'
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const client = await pool.connect()
try {
  await client.query('begin')
  const { rows } = await client.query('select id,name,nodes,edges,schema_version from workflow_configs where id=$1 for update', [workflowId])
  const saved = rows[0]
  if (!saved || saved.name !== '打工猫' || saved.schema_version !== 1) throw Error('打工猫工作流版本已改变，拒绝覆盖')
  const nodes = saved.nodes
  const script = nodes.find(node => node.id === 'node-script')
  const review = nodes.find(node => node.id === 'node-script-review')
  const image = nodes.find(node => node.id === 'node-image')
  const video = nodes.find(node => node.id === 'node-video')
  const input = nodes.find(node => node.id === 'node-input')
  if (script?.kind !== 'code' || !script.title.includes('第二镜独立试拍') || !review || !image || !video || !input
    || nodes.some(node => node.id === 'node-script-review-result-branch')) throw Error('试拍拓扑不符合预期，拒绝覆盖')
  const topic = input.params.find(param => param.englishName === 'topic')
  if (!topic || topic.type !== 'json') throw Error('主题入参不符合预期')
  topic.required = false
  topic.value = '[]'
  Object.assign(script, {
    title: '剧本生成', kind: 'text', modelId: 'codex-local-vision', outputMode: 'legacy-shots',
    operation: undefined, code: undefined, prompt: GENERIC_STORY_SCRIPT_PROMPT,
    params: [
      { id: 'story-writer-effort', name: '推理强度', englishName: 'reasoningEffort', type: 'text', required: false, value: 'high' },
      { id: 'story-writer-timeout', name: '生成超时毫秒', englishName: 'timeoutMs', type: 'number', required: false, value: '900000' },
    ],
  })
  review.modelId = 'codex-local-vision'
  review.params = review.params.map(param => param.englishName === 'source' ? { ...param, value: '${storyScriptSource}' } : param)
  review.params.push({ id: 'story-review-topics', name: '主题输入', englishName: 'topics',
    type: 'json', required: false, value: '${input.topic}' })
  image.operation = undefined
  image.modelId = 'codex-gpt-image-2'
  image.prompt = '根据已质检的分镜生成一张写实的 9:16 单格首帧图。只呈现动作开始前的同一瞬间：${shot.firstFramePrompt}。严格参照上传人物图片保持物种、面部、毛色、毛发和角色数量；按本镜描述呈现服饰、位置与道具初态。实体只出现一次，不要多格、拼贴、字幕、水印、未来动作或结尾结果。'
  image.params = image.params.filter(param => !['mode', 'previousLastFrame'].includes(param.englishName))
    .map(param => param.englishName === 'size' ? { ...param, value: '576x1024' } : param)
  video.prompt = '以本镜首帧为开场，生成一段连续的 9:16 写实短视频。严格保持人物、服饰、道具与空间连续；按剧本顺序逐项完成动作：${shot.timedActions}。机位：${shot.camera}。氛围：${shot.mood}。在 ${shot.duration} 秒内完成所有动作后保留至少 1 秒可读终态。自然环境声与动作音效，不要字幕、水印、分屏或跳切。'
  video.params.push({ id: 'story-video-ratio', name: '目标画幅', englishName: 'aspectRatio',
    type: 'text', required: true, value: '9:16' })
  const branch = {
    id: 'node-script-review-result-branch', title: '剧本质检分支', kind: 'branch',
    resultVar: 'script_review_decision', code: DEFAULT_BRANCH_CODE,
    prompt: '质检通过进入分镜循环；不通过携带问题返回普通剧本生成节点，最多尝试 3 次。',
    params: [
      { id: 'story-script-result-report', name: '剧本质检报告', englishName: 'report', type: 'json', required: true, value: '${script_review}' },
      { id: 'story-script-result-limit', name: '总尝试次数', englishName: 'maxAttempts', type: 'number', required: true, value: '3' },
    ],
    uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
    position: { x: review.position.x + 300, y: review.position.y },
  }
  const updatedNodes = nodes.flatMap(node => node.id === review.id ? [node, branch] : [node])
  const edges = saved.edges.map(edge => edge.from === review.id && edge.to === 'node-loop'
    ? { ...edge, to: branch.id } : edge)
  edges.push({ id: 'edge-script-review-pass', from: branch.id, to: 'node-loop', branch: 'true' })
  edges.push({ id: 'edge-script-review-retry', from: branch.id, to: script.id, branch: 'false' })
  const changed = await client.query('update workflow_configs set nodes=$2::jsonb,edges=$3::jsonb,schema_version=2,updated_at=now() where id=$1 and schema_version=1',
    [workflowId, JSON.stringify(updatedNodes), JSON.stringify(edges)])
  if (changed.rowCount !== 1) throw Error('工作流并发更新，拒绝覆盖')
  await client.query('commit')
  console.log(JSON.stringify({ id: workflowId, schemaVersion: 2, nodes: updatedNodes.map(node => [node.id, node.title, node.kind]), edges: edges.length }, null, 2))
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  client.release()
  await pool.end()
}
