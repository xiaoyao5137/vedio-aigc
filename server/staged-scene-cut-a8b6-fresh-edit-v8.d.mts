export const A8B6_V7_REJECTED_MD5: string
export const A8B6_V7_REVIEW_SHA: string
export const A8B6_V7_REVIEW_LEDGER: string
export const A8B6_V8_LAYOUT_MASK: {
  readonly left: number; readonly top: number;
  readonly width: number; readonly height: number; readonly color: string }
export const A8B6_V8_V4_FACE_CROP: {
  readonly left: number; readonly top: number;
  readonly width: number; readonly height: number }
export function prepareA8B6FreshV8EditReference(root?: string): Promise<{
  body: Record<string, unknown>;
  derived: { masked: Buffer; helper: Buffer };
  referenceImages: string[] }>
export function verifyA8B6FreshV8EditReceiptSync(root?: string): {
  receipt: Record<string, unknown>; receiptSha256: string }
export function verifyA8B6FreshV8EditReceipt(root?: string): Promise<{
  receipt: Record<string, unknown>; receiptSha256: string;
  referenceImages: string[] }>
export function assertA8B6FreshV8EditHop(timing: unknown, current: unknown,
  timingMd5: string, signed: unknown, rejected: unknown,
  phase?: 'pending' | 'running' | 'image-complete' | 'review-complete'
    | 'approval-running' | 'approved'): boolean
export function bindA8B6FreshV8EditReference(request: unknown,
  root?: string, options?: { previewOnly?: boolean }): Promise<{
    applied: boolean; request: unknown; receiptSha256?: string }>
export function verifyA8B6FreshV8EditPaidRequest(request: unknown,
  root?: string): Promise<{ receiptSha256: string }>
