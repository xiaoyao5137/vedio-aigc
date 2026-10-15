export const A8B6_LOCAL_COMPOSITE_RECEIPT_VERSION: string
export const A8B6_LOCAL_COMPOSITE_MARKER_VERSION: string
export const A8B6_LOCAL_COMPOSITE_PRIOR_V8: {
  readonly executionId: string; readonly resultMd5: string;
  readonly rejectedReviewSha256: string;
  readonly imageModelExecutionId: string;
  readonly reviewModelExecutionId: string }
export function verifyA8B6LocalCompositeSourceReceiptSync(root?: string): {
  receipt: Record<string, unknown> & { sources: unknown[] };
  receiptSha256: string;
  baseBytes: Buffer; outputBytes: Buffer }
export function inspectA8B6LocalCompositePixels(baseBytes: Buffer,
  outputBytes: Buffer, allowedRegions: unknown[]): Promise<{
    changedPixels: number; outsideAllowedChangedPixels: number;
    changedBounds: { minX: number; minY: number; maxX: number; maxY: number } }>
export function verifyA8B6LocalCompositeSourceReceipt(root?: string): Promise<{
  receipt: Record<string, unknown> & { sources: unknown[] };
  receiptSha256: string;
  baseBytes: Buffer; outputBytes: Buffer;
  pixelProof: { changedPixels: number; outsideAllowedChangedPixels: number;
    changedBounds: { minX: number; minY: number; maxX: number; maxY: number } } }>
export function assertA8B6LocalCompositeWorkflowResult(args: unknown): {
  approvedFirstFrameUrl: string; approvedFirstFrameSha256: string;
  frameCertificateSha256: string }
