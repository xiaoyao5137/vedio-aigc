import type { Pool, Client } from 'pg'

type Queryable = Pick<Pool | Client, 'query'>

export const SCENE_CUT_REPAIR_ANCHOR: Readonly<{
  sourceId: string
  sourceMd5: string
  parentId: string
  parentMd5: string
  originalId: string
  originalMd5: string
  sourceImageSha256: string
  sourceReviewSha256: string
  boardSha256s: readonly string[]
}>

export const SCENE_CUT_GEOMETRY_ANCHOR: Readonly<typeof SCENE_CUT_REPAIR_ANCHOR & {
  guidePath: string
  guideSha256: string
  guideJpegSha256: string
  guideProvenancePath: string
  guideProvenanceSha256: string
  guideIntermediateSha256: string
  guideDimensions: readonly number[]
}>

export function parseSceneCutRepairImageRequestKey(requestKey: string): {
  executionId: string
  attempt: number
  revision: number
  loopIndex: 0
  sceneId: 'scene-01'
}

export function readSceneCutRepairVideoContext(queryable: Queryable,
  request: unknown, root?: string): Promise<null | { executionId: string;
    recovery: unknown | null; tailGuide?: null | { endImage: string;
      endImageSha256: string; sourceVideoSha256: string } }>

export function prepareSceneCutRejectedEditBoundRequest(request: unknown,
  proof: unknown, anchor?: typeof SCENE_CUT_REPAIR_ANCHOR): Promise<{
    request: unknown
    applied: boolean
    ledgerIdentity: null | {
      requestKey: string
      requestFingerprint: string
      repairReceiptSha256: string
      preparationSha256: string
      sourceExecutionId: string
      sourceResultMd5: string
      sourceImageModelExecutionId: string
      failedReviewModelExecutionId: string
      referenceSha256s: string[]
      referenceBytes: number[]
    }
  }>

export function prepareSceneCutGeometryBoundRequest(request: unknown,
  proof: unknown, options?: { anchor?: typeof SCENE_CUT_GEOMETRY_ANCHOR;
    phase?: 'running' | 'completed' }): Promise<Awaited<ReturnType<typeof prepareSceneCutRejectedEditBoundRequest>>>

export function bindSceneCutRejectedEditReference(queryable: Queryable,
  request: unknown, root?: string): Promise<Awaited<ReturnType<typeof prepareSceneCutRejectedEditBoundRequest>>>

export function verifySceneCutRepairImageLedger(input: {
  ledger: unknown
  receipt: unknown
  candidateBytes: Buffer
  candidateUrl: string
  imageExecutionId: string
  requestFingerprint: string
  requestKey: string
  referenceOrder: unknown[]
  modelId: string
  prompt: string
  guideAnchor?: typeof SCENE_CUT_GEOMETRY_ANCHOR
}): {
  modelExecutionId: string
  requestFingerprint: string
  repairReceiptSha256: string
  candidateSha256: string
  referenceSha256s: string[]
}

export function verifySceneCutRepairReceiptForCompletedFork(queryable: Queryable,
  input: {
    executionId: string
    receipt: unknown
    candidateUrl: string
    imageExecutionId: string
    repairRequestFingerprint: string
  }, root?: string, options?: {
    anchor?: typeof SCENE_CUT_REPAIR_ANCHOR
    readGeneratedBytes?: (url: string, root: string) => Promise<Buffer>
    geometryAnchor?: typeof SCENE_CUT_GEOMETRY_ANCHOR
    readPinnedGuideBytes?: (root: string, relativePath: string, maxBytes: number) => Promise<Buffer>
  }): Promise<{
    modelExecutionId: string
    requestFingerprint: string
    repairReceiptSha256: string
    candidateSha256: string
    referenceSha256s: string[]
  }>
