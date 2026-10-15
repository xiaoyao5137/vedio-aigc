export const A8B6_V7_DUAL_OUTPUT_CHILD_ID: string
export const A8B6_V7_DUAL_OUTPUT_VERSION: string
export const A8B6_V7_FAILED_MD5: string
export const A8B6_V7_FAILED_IMAGE_LEDGER: string
export const A8B6_V7_THREAD_ID: string
export const A8B6_V7_SELECTION_CLARIFICATION: string
export const A8B6_V7_SOURCE_IMAGES: ReadonlyArray<{
  name: string; sha256: string; bytes: number }>
export function prepareA8B6V7DualOutputRecovery(root?: string): Promise<{
  body: Record<string, unknown>; normalized: Buffer }>
export function verifyA8B6V7DualOutputRecoveryReceipt(root?: string): {
  receipt: Record<string, unknown>; receiptSha256: string }
export function verifyA8B6V7DualOutputRecoveryReceiptAsync(root?: string): Promise<{
  receipt: Record<string, unknown>; receiptSha256: string }>
export function verifyA8B6V7DualOutputClarification(root?: string): {
  clarification: Record<string, unknown>; clarificationSha256: string }
export function assertA8B6V7DualOutputRecoveryHop(parent: unknown,
  child: unknown, parentMd5: string, signed: unknown,
  phase?: 'image-complete' | 'review-rejected' | 'review-complete'
    | 'approval-running' | 'approved'): boolean
