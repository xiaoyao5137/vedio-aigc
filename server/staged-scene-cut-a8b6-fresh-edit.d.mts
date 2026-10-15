export const A8B6_FRESH_V3_RESULT_MD5: string
export const A8B6_FRESH_V3_IMAGE_SHA: string
export const A8B6_FRESH_V3_REVIEW_SHA: string
export function verifyA8B6FreshEditReceiptSync(root?: string): {
  receipt: Record<string, unknown>; receiptSha256: string }
export function verifyA8B6FreshEditReceipt(root?: string): Promise<{
  receipt: Record<string, unknown>; receiptSha256: string;
  referenceImages: string[] }>
export function bindA8B6FreshEditReference(request: unknown,
  root?: string, options?: { previewOnly?: boolean }): Promise<{
    applied: boolean; request: unknown;
    receiptSha256?: string }>
export function verifyA8B6FreshEditPaidRequest(request: unknown,
  root?: string): Promise<{ receiptSha256: string }>
export function assertA8B6FreshEditHop(parent: unknown, current: unknown,
  parentMd5: string, signed: unknown, prior: unknown,
  phase?: 'pending' | 'running' | 'image-complete' | 'review-complete'
    | 'approval-running' | 'approved'): boolean
