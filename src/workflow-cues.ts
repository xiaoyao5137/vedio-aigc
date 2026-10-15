export const WORKFLOW_CUES_STORAGE_KEY = 'vedio-aigc:workflow-cues-enabled:v1'

export type WorkflowCue = 'breakpoint' | 'failed' | 'completed'
type Run = { id?: string; status: string }

export function loadWorkflowCuesEnabled(storage: Pick<Storage, 'getItem'>): boolean {
  try { return storage.getItem(WORKFLOW_CUES_STORAGE_KEY) !== 'false' }
  catch { return true }
}

export function workflowTerminalCue(before: readonly Run[], after: readonly Run[]): WorkflowCue | undefined {
  const beforeStatus = new Map(before.map(run => [run.id, run.status]))
  if (after.some(run => run.status === 'failed' && beforeStatus.get(run.id) !== 'failed')) return 'failed'
  const done = (runs: readonly Run[]) => runs.length > 0 && runs.every(run => run.status === 'success' || run.status === 'skipped')
  return done(after) && !done(before) ? 'completed' : undefined
}

let audioContext: AudioContext | undefined

export function unlockWorkflowCueAudio() {
  try {
    audioContext ??= new AudioContext()
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {})
  } catch {
    // Audio is optional when the browser or device does not expose an output.
  }
}

export function playWorkflowCue(cue: WorkflowCue) {
  try {
    unlockWorkflowCueAudio()
    const context = audioContext
    if (!context || context.state !== 'running') return
    const notes = cue === 'breakpoint' ? [660, 880] : cue === 'failed' ? [440, 330] : [523, 659, 784]
    const start = context.currentTime + 0.01
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator()
      const volume = context.createGain()
      const at = start + index * 0.13
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      volume.gain.setValueAtTime(0.0001, at)
      volume.gain.exponentialRampToValueAtTime(0.09, at + 0.012)
      volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.12)
      oscillator.connect(volume).connect(context.destination)
      oscillator.start(at)
      oscillator.stop(at + 0.13)
    })
  } catch {
    // Never let a notification interrupt execution or checkpoint persistence.
  }
}
