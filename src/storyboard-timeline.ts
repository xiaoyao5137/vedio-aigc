/** The matcher is self-contained so editable code nodes can embed the same
 * grammar. Only headers are recognized; no boundaries are rounded or repaired. */
export function storyboardTimelineMatches(source: string): RegExpExecArray[] {
  return [...source.matchAll(/(?<![\d.\-–—~～至到])(?:[（([【]\s*)?(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:秒\s*)?[-–—~～至到]\s*(\d+(?:\.\d+)?)\s*(?:秒\s*(?:[）)\]】]\s*)?|[）)\]】]\s*秒\s*)[:：]/g)]
}

export type StoryboardTimelineBeat = {
  startSecond: number
  endSecond: number
  startText: string
  endText: string
  header: string
  body: string
  index: number
  bodyStart: number
  bodyEnd: number
}

/** Keep original source offsets and body bytes, including genuine gaps,
 * overlaps and reversed windows. Validation owns those semantic decisions. */
export function parseStoryboardTimeline(source: string): StoryboardTimelineBeat[] {
  const matches = storyboardTimelineMatches(source)
  return matches.map((match, index) => {
    const bodyStart = match.index! + match[0].length
    const bodyEnd = matches[index + 1]?.index ?? source.length
    return { startSecond: Number(match[1]), endSecond: Number(match[2]),
      startText: match[1], endText: match[2], header: match[0],
      body: source.slice(bodyStart, bodyEnd), index: match.index!, bodyStart, bodyEnd }
  })
}

/** Bind the parser within each serialized function, avoiding duplicate helper
 * declarations when independent managed blocks share a code-node scope. */
export function storyboardTimelineConsumerCode(consumer: { toString(): string }) {
  return serializeRuntimeFunction(consumer, [{ dependency: storyboardTimelineMatches }])
}
import { serializeRuntimeFunction } from './serialized-runtime.ts'
