export const A8B6_FRESH_V5_REJECTED_MD5: string
export const A8B6_FRESH_V5_IMAGE_URL: string
export const A8B6_FRESH_V5_IMAGE_SHA: string
export const A8B6_FRESH_V5_REVIEW_SHA: string
export function prepareA8B6FreshV6EditReference(root?: string): Promise<{
  body: Record<string, unknown>; referenceImages: string[] }>
export function verifyA8B6FreshV6EditReceiptSync(root?: string): {
  receipt: Record<string, unknown>; receiptSha256: string }
export function verifyA8B6FreshV6EditReceipt(root?: string): Promise<{
  receipt: Record<string, unknown>; receiptSha256: string;
  referenceImages: string[] }>
export function assertA8B6FreshV6EditHop(parent: unknown, current: unknown,
  parentMd5: string, signed: unknown, rejected: unknown,
  phase?: 'pending' | 'running' | 'image-complete' | 'review-complete'
    | 'approval-running' | 'approved'): boolean
export function bindA8B6FreshV6EditReference(request: unknown,
  root?: string, options?: { previewOnly?: boolean }): Promise<{
    applied: boolean; request: unknown; receiptSha256?: string }>
export function verifyA8B6FreshV6EditPaidRequest(request: unknown,
  root?: string): Promise<{ receiptSha256: string }>
