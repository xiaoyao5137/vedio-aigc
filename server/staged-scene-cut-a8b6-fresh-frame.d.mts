export const A8B6_FRESH_FRAME_ID: string
export const A8B6_FRESH_FRAME_VERSION: string
export const A8B6_FRESH_FIRST_FRAME_PROMPT: string
export const A8B6_FRESH_REVIEW_PROMPT: string
export const A8B6_FRESH_FIRST_PROMPT_SHA: string
export const A8B6_FRESH_REVIEW_PROMPT_SHA: string
export const A8B6_FRESH_V2_RESULT_MD5: string
export const A8B6_FRESH_V2_IMAGE_SHA: string
export const A8B6_FRESH_V2_IMAGE_URL: string
export const A8B6_FRESH_V2_IMAGE_LEDGER: string
export const A8B6_FRESH_V2_REVIEW_LEDGER: string

export function verifyA8B6FreshV2Rejection(row: unknown,
  imageLedger: unknown, reviewLedger: unknown, root?: string): Promise<{
    state: unknown; reviewSha256: string; imageSha256: string }>

export function assertA8B6FreshFrameHop(parent: unknown, current: unknown,
  parentMd5: string, conflictReceipt: unknown, priorFresh: unknown,
  phase?: 'pending' | 'image-complete' | 'review-complete'
    | 'approval-running' | 'approved'): boolean
export function verifyA8B6FreshImageRequest(request: unknown,
  root?: string): Promise<unknown>
export function verifyA8B6FreshImageBytes(url: unknown,
  root?: string): string
