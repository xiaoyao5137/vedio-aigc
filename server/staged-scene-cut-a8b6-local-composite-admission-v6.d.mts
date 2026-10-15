export function verifyA8B6LocalCompositeSourceReceiptV6Sync(root?: string): {
  receipt: Record<string, any> & { sources: any[] };
  receiptSha256: string;
  baseBytes: Buffer; wallRawBytes: Buffer; outputBytes: Buffer }
export function verifyA8B6LocalCompositeSourceReceiptV6(root?: string): Promise<{
  receipt: Record<string, any> & { sources: any[] };
  receiptSha256: string;
  baseBytes: Buffer; wallRawBytes: Buffer; outputBytes: Buffer;
  pixelProof: Record<string, unknown> }>
export function assertA8B6LocalCompositeWorkflowResultV6(args: any): {
  approvedFirstFrameUrl: string; approvedFirstFrameSha256: string;
  frameCertificateSha256: string }
