/** Original-speed frame facts for new, source-bound A8+B6 media. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const invalid = message => { throw Error(`A8B6_FRESH_NATIVE_INVALID: ${message}`) }
const sha = value => createHash('sha256').update(value).digest('hex')

/** Parses native decoded PTS; no container-duration rounding is used. */
export function parseFreshNativeFrameMd5(output) {
  const lines = String(output).split(/\r?\n/)
  if (!lines.some(line => line.trim() === '#tb 0: 1/24')
    || !lines.some(line => line.trim() === '#dimensions 0: 1280x720'))
    invalid('native source is not 1280x720 at 24fps')
  const frameLines = lines.filter(line => /^0,/.test(line))
  const frames = frameLines.map((line, index) => {
    const fields = line.split(',').map(field => field.trim())
    const pts = Number(fields[2]), duration = Number(fields[3])
    if (fields.length !== 6 || Number(fields[0]) !== 0
      || !Number.isInteger(pts) || pts !== index
      || duration !== 1 || !/^[a-f0-9]{32}$/.test(fields[5]))
      invalid('native frame PTS/digest is discontinuous')
    return { index, pts, md5: fields[5] }
  })
  if (frames.length < 2) invalid('native source has no continuous video')
  return { fps: 24, width: 1280, height: 720,
    frameCount: frames.length, firstPts: 0,
    lastPts: (frames.length - 1) / 24,
    lastFrameIndex: frames.length - 1,
    frameDigestSha256: sha(frameLines.join('\n')),
    firstFrameMd5: frames[0].md5, lastFrameMd5: frames.at(-1).md5 }
}

export async function inspectFreshNativeVideo(filename) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-map', '0:v:0', '-an', '-f', 'framemd5', '-'],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 5 * 1024 * 1024 })
  return parseFreshNativeFrameMd5(stdout)
}

export async function extractFreshNativeJpeg(filename, frameIndex) {
  if (!Number.isInteger(frameIndex) || frameIndex < 0)
    invalid('native JPEG frame index invalid')
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-vf', `select=eq(n\\,${frameIndex})`, '-vsync', 'vfr', '-frames:v', '1',
    '-q:v', '2', '-f', 'image2', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 20 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 1000
    || stdout[0] !== 0xff || stdout[1] !== 0xd8)
    invalid(`native frame ${frameIndex} did not decode`)
  return { bytes: stdout, sha256: sha(stdout) }
}

/** The B zero frame is a request/seam witness and is omitted once on concat. */
export function assertFreshA8B6FrameMapping(aNative, bNative,
  { acceptedAEndFrameIndex, acceptedBEndFrameIndex }) {
  const aEnd = acceptedAEndFrameIndex, bEnd = acceptedBEndFrameIndex
  if (aNative?.fps !== 24 || bNative?.fps !== 24
    || aNative.width !== 1280 || bNative.width !== 1280
    || aNative.height !== 720 || bNative.height !== 720
    || !Number.isInteger(aEnd) || !Number.isInteger(bEnd)
    || aEnd < 1 || bEnd < 1
    || aEnd !== aNative.lastFrameIndex
    || bEnd !== bNative.lastFrameIndex)
    invalid('native accepted source frame indices are absent or out of range')
  const aSeconds = aEnd / 24, bSeconds = bEnd / 24
  const lastPts = (aEnd + bEnd) / 24
  // Each complete native take may end one frame either side of its nominal
  // 8 s / 6 s mark. Their PTS offsets add; retain both full takes at 1×.
  if (Math.abs(aSeconds - 8) > 1 / 24 + 1e-8
    || Math.abs(bSeconds - 6) > 1 / 24 + 1e-8
    || Math.abs(lastPts - 14) > 2 / 24 + 1e-8)
    invalid('native source cut does not preserve approved 8+6 original-speed timing')
  return { version: 'a8b6-fresh-original-speed-mapping-v1', fps: 24,
    phaseA: { sourceFirstFrameIndex: 0, sourceLastFrameIndex: aEnd,
      outputFirstFrameIndex: 0, outputLastFrameIndex: aEnd,
      acceptedTailPts: aSeconds },
    phaseB: { sourceFirstFrameIndex: 1, sourceLastFrameIndex: bEnd,
      outputFirstFrameIndex: aEnd + 1,
      outputLastFrameIndex: aEnd + bEnd,
      requestedFirstFrameIndex: 0, acceptedTailPts: bSeconds },
    frameCount: aEnd + bEnd + 1, firstPts: 0, lastPts,
    approvedDurationSeconds: 14, playbackRate: 1 }
}
