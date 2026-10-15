export const A8B6_LOCAL_V7_REJECTED_V6: {
  readonly executionId: string;
  readonly resultMd5: string;
  readonly sourceReceiptSha256: string;
  readonly rejectedReviewSha256: string;
  readonly reviewModelExecutionId: string;
  readonly frameApprovalStatus: string;
  readonly imageLedgerCount: number;
  readonly reviewLedgerCount: number;
  readonly issueCodes: readonly string[] }
export function assertA8B6LocalV7RejectedV6State(state: unknown,
  resultMd5: string, timing: unknown, timingResultMd5: string,
  signed: unknown, reviewLedgers: unknown[], imageLedgers: unknown[],
  root?: string): typeof A8B6_LOCAL_V7_REJECTED_V6
export function verifyA8B6LocalV7RejectedV6Ancestry(root?: string): Promise<{
  rejected: typeof A8B6_LOCAL_V7_REJECTED_V6;
  sourceReceiptSha256: string; timingResultMd5: string;
  rejectedImageSha256: string }>
