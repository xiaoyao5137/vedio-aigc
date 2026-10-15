export function verifyA8B6LocalCompositeSourceReceiptV3Sync(root?: string): {
  receipt: Record<string, unknown> & { sources: unknown[] };
  receiptSha256: string; baseBytes: Buffer; wallRawBytes: Buffer;
  faceRawBytes: Buffer; gateFrameRawBytes: Buffer; outputBytes: Buffer }
export function inspectA8B6LocalCompositePixelsV3(baseBytes: Buffer,
  outputBytes: Buffer, regions: unknown[]): Promise<{
    changedPixels: number; outsideAllowedChangedPixels: number;
    changedBounds: { minX: number; minY: number; maxX: number; maxY: number } }>
export function verifyA8B6LocalCompositeSourceReceiptV3(root?: string): Promise<{
  receipt: Record<string, unknown> & { sources: unknown[] };
  receiptSha256: string; baseBytes: Buffer; wallRawBytes: Buffer;
  faceRawBytes: Buffer; gateFrameRawBytes: Buffer; outputBytes: Buffer;
  pixelProof: { changedPixels: number; outsideAllowedChangedPixels: number;
    changedBounds: { minX: number; minY: number; maxX: number; maxY: number } } }>
export function assertA8B6LocalCompositeWorkflowResultV3(args: unknown): {
  approvedFirstFrameUrl: string; approvedFirstFrameSha256: string;
  frameCertificateSha256: string }
