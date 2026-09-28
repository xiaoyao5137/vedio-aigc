import { parseStoryboardTimeline } from './storyboard-timeline.ts'

type RecordValue = Record<string, unknown>
export type StoryboardAdvisory = { code: string; path: string; message: string }

/** Editorial preferences are visible advice, not reasons to buy another draft.
 * Executable clocks, complete dialogue and story/evidence contracts are checked
 * separately by the validator. These heuristics cannot judge actual footage. */
export function storyboardAdvisories(value: unknown, path = ''): StoryboardAdvisory[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const shot = value as RecordValue
  if (Array.isArray(shot.segments)) return shot.segments.flatMap((segment, index) => storyboardAdvisories(segment, `segments.${index}.`))
  if (typeof shot.videoPrompt !== 'string') return []
  const script = shot.videoPrompt.split(/【(?!\s*(?:第\s*)?\d)/)[0]
  const ranges = parseStoryboardTimeline(script)
  const warnings: StoryboardAdvisory[] = []
  const add = (code: string, key: string, message: string) => warnings.push({ code, path: path + key, message })
  if (script.length > 650) add('STORYBOARD_PROMPT_LENGTH_ADVICE', 'videoPrompt', `分镜正文 ${script.length} 字符，建议精简重复描述；完整视频请求仍须满足模型长度限制。`)
  if (ranges.length && (ranges.length < 3 || ranges.length > 6)) add('STORYBOARD_SEGMENT_COUNT_ADVICE', 'videoPrompt', `当前 ${ranges.length} 个连续区间；3–6 段是编排建议，不要求为凑段数重写。`)
  if ((shot.pacing as RecordValue)?.version === 'dynamic-v1') {
    for (const range of ranges) {
      const action = range.body.replace(/(?:禁止|不得|不许|不要|避免|严禁|不能)[^，,。；;\n]*/g, '').replace(/[「“"『][^」”"』]*[」”"』]/g, '')
      if (range.endSecond - range.startSecond > 1.2 + 1e-9 && /(?:静止|保持.{0,15}(?:姿态|构图|不动)|站立不动|空等)/.test(action)) {
        add('STORYBOARD_HOLD_ADVICE', 'videoPrompt', `${range.startSecond}–${range.endSecond}秒含姿态保持：${range.body.trim()}。结合旁白、运镜及实际表演判断节奏，不据此认定无声空等。`)
      }
    }
  }
  return warnings
}
