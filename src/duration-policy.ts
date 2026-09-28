/** One serializable policy is carried from planning to media review. Measurement
 * uncertainty never subtracts from the content or ending budget. */
export const DURATION_PACING_VERSION = 'duration-v2'
export type DeliveryStyle = 'dialogue' | 'narration' | 'chant' | 'singing'
export type DurationPolicy = {
  version: string
  speech: Record<DeliveryStyle, { referenceRate: number; minimumNaturalRate: number; maximumRate: number; startupAllowance: number }>
  shortPauseSeconds: number; sentencePauseSeconds: number; linePauseSeconds: number
  measurementToleranceSeconds: number; endingReadabilityReserve: number
  maxConservativeExtraSeconds: number; minimumProviderDuration: number; maximumProviderDuration: number
  minimumVocalizationSeconds: number; minimumActionSeconds: number; minimumReactionSeconds: number
}

/** Single lexical unit: exported helpers and sandbox code use the exact same
 * implementation, including after production minification renames local symbols. */
export function durationPolicyRuntimeFactory() {
const DEFAULT_DURATION_POLICY: DurationPolicy = {
  // Principle-mode production may trade leisurely delivery for throughput, but
  // only on detached narration. Character dialogue, chants and songs retain
  // their established performance bounds. 5.5 chars/s keeps a source-faithful
  // historical voice-over intelligible while allowing roughly 65-70 Han
  // characters plus punctuation inside a 15-second provider clip.
  version: 'duration-policy-v2.2-brisk-narration',
  speech: {
    dialogue: { referenceRate: 4.5, minimumNaturalRate: 3.3, maximumRate: 5, startupAllowance: 0.25 },
    narration: { referenceRate: 5.8, minimumNaturalRate: 5.5, maximumRate: 6.5, startupAllowance: 0.25 },
    chant: { referenceRate: 3.3, minimumNaturalRate: 2.8, maximumRate: 4.5, startupAllowance: 0.25 },
    singing: { referenceRate: 2.8, minimumNaturalRate: 2, maximumRate: 3.5, startupAllowance: 0.35 },
  },
  shortPauseSeconds: 0.15, sentencePauseSeconds: 0.25, linePauseSeconds: 0.2,
  measurementToleranceSeconds: 0.25, endingReadabilityReserve: 0.5,
  maxConservativeExtraSeconds: 1, minimumProviderDuration: 3, maximumProviderDuration: 15,
  minimumVocalizationSeconds: 0.8, minimumActionSeconds: 0.3, minimumReactionSeconds: 0.5,
}

function resolveDurationPolicy(value?: unknown): DurationPolicy {
  const policy = value === undefined ? DEFAULT_DURATION_POLICY : value
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('STORYBOARD_PACING_INVALID: 缺少共享 duration-v2 时长策略')
  const row = policy as DurationPolicy
  if (row.version !== DEFAULT_DURATION_POLICY.version || !row.speech) throw new Error('STORYBOARD_PACING_INVALID: 未知时长策略版本，须显式重新规划')
  // Config may be made more conservative, but a candidate cannot lower the
  // shipped content safeguards while claiming the same policy version.
  for (const key of ['shortPauseSeconds', 'sentencePauseSeconds', 'linePauseSeconds', 'endingReadabilityReserve', 'minimumVocalizationSeconds', 'minimumActionSeconds', 'minimumReactionSeconds'] as const) {
    if (!Number.isFinite(row[key]) || row[key] < DEFAULT_DURATION_POLICY[key] || row[key] > 5) throw new Error(`STORYBOARD_PACING_INVALID: timingPolicy.${key} 不得低于版本下界或超出有效范围`)
  }
  if (row.measurementToleranceSeconds !== DEFAULT_DURATION_POLICY.measurementToleranceSeconds
    || row.minimumProviderDuration !== 3 || row.maximumProviderDuration !== 15
    || !Number.isInteger(row.maxConservativeExtraSeconds) || row.maxConservativeExtraSeconds < 0 || row.maxConservativeExtraSeconds > 2) throw new Error('STORYBOARD_PACING_INVALID: 时长能力、测量容差或额外整数预算无效')
  for (const style of ['dialogue', 'narration', 'chant', 'singing'] as const) {
    const speech = row.speech[style], base = DEFAULT_DURATION_POLICY.speech[style]
    if (!speech || !['referenceRate', 'minimumNaturalRate', 'maximumRate', 'startupAllowance'].every(key => Number.isFinite(speech[key as keyof typeof speech]))
      || speech.minimumNaturalRate <= 0 || speech.minimumNaturalRate > base.minimumNaturalRate
      || speech.referenceRate < speech.minimumNaturalRate || speech.referenceRate > base.referenceRate
      || speech.maximumRate < speech.referenceRate || speech.maximumRate > base.maximumRate
      || speech.startupAllowance < base.startupAllowance || speech.startupAllowance > 2) throw new Error(`STORYBOARD_PACING_INVALID: ${style} 声部策略无效或低估自然表演预算`)
  }
  return JSON.parse(JSON.stringify(row)) as DurationPolicy
}

function estimateSpeechDuration(text: string, deliveryStyle: DeliveryStyle, value?: unknown) {
  const policy = resolveDurationPolicy(value), style = policy.speech[deliveryStyle]
  if (!style) throw new Error('STORYBOARD_PACING_INVALID: 声部必须声明 dialogue/narration/chant/singing 表演类型')
  // Beat text is already the spoken body. Do not mistake a colon inside an
  // actual sentence for a speaker label and silently remove those words.
  const spoken = text
  const characters = [...spoken].filter(character => /\p{Script=Han}/u.test(character)).length
  if (!characters && spoken.trim()) throw new Error('STORYBOARD_PACING_INVALID: 当前声部语速策略不能估算非汉字台词，请提供经过审核的语言策略')
  const shortPauses = (spoken.match(/[，,；;、：:]/g) ?? []).length
  const sentencePauses = (spoken.match(/[。！？!?]/g) ?? []).length
  const linePauses = Math.max(0, spoken.split('\n').filter(line => line.trim()).length - 1)
  const pauseSeconds = shortPauses * policy.shortPauseSeconds + sentencePauses * policy.sentencePauseSeconds + linePauses * policy.linePauseSeconds
  const round = (seconds: number) => Math.ceil((seconds - 1e-9) * 1000) / 1000
  return { characters, shortPauses, sentencePauses, linePauses, pauseSeconds,
    lower: round(characters / style.maximumRate + pauseSeconds),
    expected: round(characters / style.referenceRate + pauseSeconds),
    upper: round(characters / style.minimumNaturalRate + pauseSeconds + (characters ? style.startupAllowance : 0)),
    source: `${policy.version}:${deliveryStyle}:cold-start-baseline`, confidence: 'low' as const,
    referenceRate: style.referenceRate, minimumNaturalRate: style.minimumNaturalRate,
    startupAllowance: style.startupAllowance, measurementToleranceSeconds: policy.measurementToleranceSeconds }
}

/** Stable JSON and a synchronous SHA-256 keep browser/server verification equal,
 * without Node crypto or asynchronous WebCrypto in workflow validation. */
function durationCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(item => durationCanonicalJson(item ?? null)).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + durationCanonicalJson((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value ?? null)
}

function durationContentHash(value: unknown): string {
  const bytes = new TextEncoder().encode(durationCanonicalJson(value))
  const length = Math.ceil((bytes.length + 9) / 64) * 64, data = new Uint8Array(length)
  data.set(bytes); data[bytes.length] = 0x80
  const view = new DataView(data.buffer), bitLength = bytes.length * 8
  view.setUint32(length - 8, Math.floor(bitLength / 0x100000000)); view.setUint32(length - 4, bitLength >>> 0)
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const w = new Uint32Array(64), rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < length; offset += 64) {
    for (let index = 0; index < 16; index++) w[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index++) {
      const x = w[index - 15], y = w[index - 2]
      w[index] = (w[index - 16] + (rotate(x,7) ^ rotate(x,18) ^ (x >>> 3)) + w[index - 7] + (rotate(y,17) ^ rotate(y,19) ^ (y >>> 10))) >>> 0
    }
    let [a,b,c,d,e,f,g,q] = h
    for (let index = 0; index < 64; index++) {
      const t1 = (q + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + k[index] + w[index]) >>> 0
      const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      q=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0
    }
    for (const [index, value] of [a,b,c,d,e,f,g,q].entries()) h[index] = (h[index] + value) >>> 0
  }
  return h.map(value => value.toString(16).padStart(8, '0')).join('')
}

function durationPolicyHash(value?: unknown) { return durationContentHash(resolveDurationPolicy(value)) }


return { DEFAULT_DURATION_POLICY, resolveDurationPolicy, estimateSpeechDuration, durationCanonicalJson, durationContentHash, durationPolicyHash }
}

export const { DEFAULT_DURATION_POLICY, resolveDurationPolicy, estimateSpeechDuration, durationCanonicalJson, durationContentHash, durationPolicyHash } = durationPolicyRuntimeFactory()

export const DURATION_POLICY_RUNTIME_CODE = `const __durationPolicyV2Runtime=(${durationPolicyRuntimeFactory.toString()})();\nconst {DEFAULT_DURATION_POLICY, resolveDurationPolicy, estimateSpeechDuration, durationCanonicalJson, durationContentHash, durationPolicyHash}=__durationPolicyV2Runtime;`
