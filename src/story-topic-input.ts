/** An empty topic list asks the script model to invent one topic per shot. */
export function normalizeStoryTopics(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return []
  return value
}

export function validateStoryTopicInput(value: unknown, countValue: unknown): string {
  const topics = normalizeStoryTopics(value)
  const count = Number(countValue)
  if (!Array.isArray(topics)) return '主题字段必须是 JSON 数组，例如 ["买早餐", "公司午睡"]，也可留空或填写 []'
  if (!Number.isSafeInteger(count) || count <= 0) return '视频数量必须是大于 0 的整数'
  if (topics.length && topics.length !== count) return `视频数量 ${count} 与主题数量 ${topics.length} 不一致，请一一对应`
  if (topics.some(topic => typeof topic !== 'string' || !topic.trim())) return '主题数组中只能填写非空字符串'
  return ''
}

export function generatedStoryTopicIssues(inputTopics: unknown, output: unknown): string[] {
  const topics = normalizeStoryTopics(inputTopics)
  if (!Array.isArray(topics)) return ['主题输入不是数组']
  const shots = Array.isArray(output) ? output : output && typeof output === 'object'
    ? (output as { shots?: unknown[] }).shots : undefined
  if (!Array.isArray(shots)) return ['剧本缺少分镜数组']
  const generated: string[] = []
  const issues: string[] = []
  shots.forEach((shot, index) => {
    const topic = shot && typeof shot === 'object' && !Array.isArray(shot)
      ? (shot as { topic?: unknown }).topic : undefined
    if (typeof topic !== 'string' || !topic.trim()) {
      issues.push(`第 ${index + 1} 镜缺少生成的主题`)
    } else {
      generated.push(topic.trim())
      if (topics.length && topic.trim() !== topics[index]) issues.push(`第 ${index + 1} 镜主题与输入顺序不一致`)
    }
  })
  if (!topics.length && new Set(generated).size !== generated.length) issues.push('模型生成了重复主题')
  return issues
}

export const STORY_OPTIONAL_TOPIC_INSTRUCTION = '【主题输入规则】主题数组为空或未填写时，请自行构思与平台、角色设定相符且彼此不同的主题，严格生成视频数量指定的分镜；在每个分镜的 topic 字段写明本镜生成的主题。主题数组有值时，按数组顺序逐项使用，每镜 topic 与输入主题一致。不得把空数组当成一个主题，也不得沿用示例主题。'

export function upgradeStoryScriptTopicPrompt(prompt: string): string {
  return prompt.includes('【主题输入规则】') ? prompt : `${STORY_OPTIONAL_TOPIC_INSTRUCTION}\n${prompt}`
}
