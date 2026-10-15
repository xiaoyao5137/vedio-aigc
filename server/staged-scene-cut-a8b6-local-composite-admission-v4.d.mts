export function verifyA8B6LocalCompositeSourceReceiptV4Sync(root?: string): {
  receipt: Record<string, unknown> & { sources: unknown[] };
  receiptSha256: string;
  baseBytes: Buffer; wallRawBytes: Buffer; outputBytes: Buffer }
export function verifyA8B6LocalCompositeSourceReceiptV4(root?: string): Promise<{
  receipt: Record<string, unknown> & { sources: unknown[] };
  receiptSha256: string;
  baseBytes: Buffer; wallRawBytes: Buffer; outputBytes: Buffer;
  pixelProof: Record<string, unknown> }>
export function inspectA8B6LocalCompositePixelsV4(baseBytes: Buffer,
  outputBytes: Buffer, regions: unknown): Promise<Record<string, unknown>>
export function assertA8B6LocalCompositeWorkflowResultV4(args: unknown): {
  approvedFirstFrameUrl: string; approvedFirstFrameSha256: string;
  frameCertificateSha256: string }
