export function verifyA8B6LocalCompositeSourceReceiptV9Sync(root?: string): {
  receipt: Record<string, any> & { sources: any[] };
  receiptSha256: string;
  baseBytes: Buffer; wallRawBytes: Buffer; outputBytes: Buffer }
export function verifyA8B6LocalCompositeSourceReceiptV9(root?: string): Promise<{
  receipt: Record<string, any> & { sources: any[] };
  receiptSha256: string;
  baseBytes: Buffer; wallRawBytes: Buffer; outputBytes: Buffer;
  pixelProof: Record<string, unknown> }>
export function inspectA8B6LocalCompositePixelsV9(baseBytes: Buffer,
  outputBytes: Buffer, regions: unknown): Promise<{
    changedPixels: number; outsideAllowedChangedPixels: number;
    changedBounds: { minX: number; minY: number; maxX: number; maxY: number } }>
export function assertA8B6LocalCompositeWorkflowResultV9(args: any): {
  approvedFirstFrameUrl: string; approvedFirstFrameSha256: string;
  frameCertificateSha256: string }
