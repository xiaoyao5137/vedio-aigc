import { useEffect, useState } from 'react'

type TimedRun = { status: string; startedAt?: number; durationMs: number }

/** Execution start times use performance.now(), matching the runner's final duration. */
export function RunDuration({ run }: { run: TimedRun }) {
  const [now, setNow] = useState(() => performance.now())
  const isRunning = run.status === 'running' && run.startedAt !== undefined

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => setNow(performance.now()), 100)
    return () => window.clearInterval(timer)
  }, [isRunning, run.startedAt])

  const duration = isRunning
    ? Math.max(run.durationMs, Math.round(now - run.startedAt!), 0)
    : run.durationMs
  return <>{duration}ms</>
}
