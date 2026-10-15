export const A8B6_LOCAL_V3_REJECTED_V2: {
  readonly executionId: string; readonly resultMd5: string;
  readonly rejectedReviewSha256: string;
  readonly reviewModelExecutionId: string;
  readonly imageLedgerCount: number;
  readonly frameApprovalStatus: string }
export function assertA8B6LocalV3RejectedV2State(state: unknown,
  resultMd5: string, reviewLedger: unknown, imageLedgers: unknown[],
  root?: string): typeof A8B6_LOCAL_V3_REJECTED_V2
export function verifyA8B6LocalV3RejectedV2Ancestry(root?: string): Promise<{
  rejected: typeof A8B6_LOCAL_V3_REJECTED_V2;
  sourceReceiptSha256: string; timingResultMd5: string }>
