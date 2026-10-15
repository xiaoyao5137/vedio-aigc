export function verifyA8B6LocalCompositeSourceReceiptV2Sync(root?: string): {
  receipt: Record<string, unknown> & { sources: unknown[] };
  receiptSha256: string;
  baseBytes: Buffer; rawBytes: Buffer; outputBytes: Buffer }
export function inspectA8B6LocalCompositePixelsV2(baseBytes: Buffer,
  outputBytes: Buffer, polygons: number[][][]): Promise<{
    changedPixels: number; outsideAllowedChangedPixels: number;
    changedBounds: { minX: number; minY: number; maxX: number; maxY: number } }>
export function verifyA8B6LocalCompositeSourceReceiptV2(root?: string): Promise<{
  receipt: Record<string, unknown> & { sources: unknown[] };
  receiptSha256: string;
  baseBytes: Buffer; rawBytes: Buffer; outputBytes: Buffer;
  pixelProof: { changedPixels: number; outsideAllowedChangedPixels: number;
    changedBounds: { minX: number; minY: number; maxX: number; maxY: number } } }>
export function assertA8B6LocalCompositeWorkflowResultV2(args: unknown): {
  approvedFirstFrameUrl: string; approvedFirstFrameSha256: string;
  frameCertificateSha256: string }
