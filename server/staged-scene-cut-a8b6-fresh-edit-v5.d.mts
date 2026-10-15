export const A8B6_FRESH_V4_IMAGE_MD5: string
export const A8B6_FRESH_V4_REVIEW_MD5: string
export const A8B6_FRESH_V4_IMAGE_URL: string
export const A8B6_FRESH_V4_IMAGE_SHA: string
export const A8B6_FRESH_V4_REVIEW_SHA: string
export const A8B6_FRESH_V5_PRE_PROVIDER_FAILED_MD5: string
export function verifyA8B6FreshV5EditReceiptSync(root?: string): {
  receipt: Record<string, unknown>; receiptSha256: string }
export function verifyA8B6FreshV5EditReceipt(root?: string): Promise<{
  receipt: Record<string, unknown>; receiptSha256: string;
  referenceImages: string[] }>
export function bindA8B6FreshV5EditReference(request: unknown,
  root?: string, options?: { previewOnly?: boolean }): Promise<{
    applied: boolean; request: unknown; receiptSha256?: string }>
export function verifyA8B6FreshV5EditPaidRequest(request: unknown,
  root?: string): Promise<{ receiptSha256: string }>
export function assertA8B6FreshV5EditHop(parent: unknown, current: unknown,
  parentMd5: string, signed: unknown, rejectedImage: unknown,
  rejectedReview: unknown,
  phase?: 'pending' | 'running' | 'pre-provider-failed'
    | 'image-complete' | 'review-complete'
    | 'approval-running' | 'approved'): boolean
export function assertA8B6FreshV5RuntimeRetryHop(parent: unknown,
  child: unknown, parentMd5: string,
  phase?: 'pending' | 'running' | 'image-complete' | 'review-complete'
    | 'approval-running' | 'approved'): boolean
