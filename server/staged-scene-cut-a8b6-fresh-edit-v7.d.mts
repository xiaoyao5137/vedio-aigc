export const A8B6_FRESH_V6_REJECTED_MD5: string
export const A8B6_FRESH_V6_IMAGE_URL: string
export const A8B6_FRESH_V6_IMAGE_SHA: string
export const A8B6_FRESH_V6_REVIEW_SHA: string
export const A8B6_FRESH_V7_YAN_FRONT_URL: string
export const A8B6_FRESH_V7_YAN_FRONT_SHA: string
export const A8B6_FRESH_V7_FACE_CROP: {
  readonly left: number; readonly top: number;
  readonly width: number; readonly height: number }
export function prepareA8B6FreshV7EditReference(root?: string): Promise<{
  body: Record<string, unknown>; referenceImages: string[] }>
export function verifyA8B6FreshV7EditReceiptSync(root?: string): {
  receipt: Record<string, unknown>; receiptSha256: string }
export function verifyA8B6FreshV7EditReceipt(root?: string): Promise<{
  receipt: Record<string, unknown>; receiptSha256: string;
  referenceImages: string[] }>
export function assertA8B6FreshV7EditHop(parent: unknown, current: unknown,
  parentMd5: string, signed: unknown, rejected: unknown,
  phase?: 'pending' | 'running' | 'dual-output-failed' | 'image-complete' | 'review-complete'
    | 'approval-running' | 'approved'): boolean
export function bindA8B6FreshV7EditReference(request: unknown,
  root?: string, options?: { previewOnly?: boolean }): Promise<{
    applied: boolean; request: unknown; receiptSha256?: string }>
export function verifyA8B6FreshV7EditPaidRequest(request: unknown,
  root?: string): Promise<{ receiptSha256: string }>
