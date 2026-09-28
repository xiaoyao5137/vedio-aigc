export type VideoExecutionMode = 'run' | 'step'
export type VideoResolution = '720p' | '4k'
export const VIDEO_OUTPUT_PROFILE_VERSION = '2026-09-25-omni-4k-v1'

export type VideoOutputProfile = {
  id: 'debug-720p' | 'production-omni-4k'
  executionMode: VideoExecutionMode
  resolution: VideoResolution
  width: number
  height: number
  fps: 24
  audioSampleRate: 48000
  klingMode: 'std' | 'pro'
  klingModelName?: 'kling-v3-omni'
}

const DIMENSIONS: Record<VideoResolution, Record<string, [number, number]>> = {
  '720p': { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720] },
  '4k': { '16:9': [3840, 2160], '9:16': [2160, 3840], '1:1': [2160, 2160] },
}

export function videoDimensions(resolution: VideoResolution, aspectRatio = '16:9'): [number, number] {
  const dimensions = DIMENSIONS[resolution][aspectRatio]
  if (!dimensions) throw new Error(`VIDEO_OUTPUT_PROFILE_INVALID: 不支持画幅 ${aspectRatio}`)
  return dimensions
}

/** A full workflow run is a delivery render; step execution is a low-cost preview.
 * Keep this decision outside editable node params so a stale saved workflow cannot
 * accidentally buy 4K during debugging or emit 720p during formal production. */
export function resolveVideoOutputProfile(executionMode: VideoExecutionMode, aspectRatio = '16:9'): VideoOutputProfile {
  const production = executionMode === 'run'
  const resolution: VideoResolution = production ? '4k' : '720p'
  const [width, height] = videoDimensions(resolution, aspectRatio)
  return {
    id: production ? 'production-omni-4k' : 'debug-720p',
    executionMode,
    resolution,
    width,
    height,
    fps: 24,
    audioSampleRate: 48000,
    klingMode: production ? 'pro' : 'std',
    ...(production ? { klingModelName: 'kling-v3-omni' as const } : {}),
  }
}

export function applyVideoOutputProfile(params: Record<string, unknown>, executionMode: VideoExecutionMode) {
  const aspectRatio = String(params.aspectRatio ?? params.aspect_ratio ?? '16:9')
  const profile = resolveVideoOutputProfile(executionMode, aspectRatio)
  return {
    ...params,
    outputProfile: profile.id,
    executionMode: profile.executionMode,
    resolution: profile.resolution,
    width: profile.width,
    height: profile.height,
    fps: profile.fps,
    audioSampleRate: profile.audioSampleRate,
    mode: profile.klingMode,
    ...(profile.klingModelName ? { model_name: profile.klingModelName } : {}),
  }
}
