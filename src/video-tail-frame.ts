function waitForMediaEvent(target: HTMLVideoElement, success: string, failure: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timeout)
      target.removeEventListener(success, onSuccess)
      target.removeEventListener(failure, onFailure)
      if (error) reject(error)
      else resolve()
    }
    const onSuccess = () => finish()
    const onFailure = () => finish(new Error('视频尾帧提取时无法解码成片'))
    const timeout = window.setTimeout(() => finish(new Error(`视频尾帧提取等待 ${success} 超时`)), timeoutMs)
    target.addEventListener(success, onSuccess, { once: true })
    target.addEventListener(failure, onFailure, { once: true })
  })
}

export function tailFrameSeekTime(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('成片没有有效时长，无法提取尾帧')
  return Math.max(0, duration - Math.min(0.08, duration / 2))
}

/** Downloads through the same-origin proxy and captures the final decodable frame. */
export async function captureVideoTailFrame(videoUrl: string) {
  const source = /^https?:\/\//i.test(videoUrl)
    ? `/api/media-download?url=${encodeURIComponent(videoUrl)}&filename=continuity-source.mp4&inline=1`
    : videoUrl
  const response = await fetch(source)
  if (!response.ok) throw new Error(`成片下载失败：HTTP ${response.status}`)
  const objectUrl = URL.createObjectURL(await response.blob())
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  try {
    const metadataReady = waitForMediaEvent(video, 'loadedmetadata', 'error', 30_000)
    video.src = objectUrl
    await metadataReady
    const seeked = waitForMediaEvent(video, 'seeked', 'error', 30_000)
    video.currentTime = tailFrameSeekTime(video.duration)
    await seeked
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context || !canvas.width || !canvas.height) throw new Error('成片没有可绘制的视频画面')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.92)
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
}
