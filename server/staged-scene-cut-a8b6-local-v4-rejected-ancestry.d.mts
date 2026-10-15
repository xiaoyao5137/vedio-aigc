export const A8B6_LOCAL_V4_REJECTED_V3: {
  readonly executionId: string; readonly resultMd5: string;
  readonly rejectedReviewSha256: string;
  readonly reviewModelExecutionId: string;
  readonly imageLedgerCount: number;
  readonly frameApprovalStatus: string;
  readonly soleIssueCode: string }
export function assertA8B6LocalV4RejectedV3State(state: unknown,
  resultMd5: string, reviewLedgers: unknown[], imageLedgers: unknown[],
  root?: string): typeof A8B6_LOCAL_V4_REJECTED_V3
export function verifyA8B6LocalV4RejectedV3Ancestry(root?: string): Promise<{
  rejected: typeof A8B6_LOCAL_V4_REJECTED_V3;
  sourceReceiptSha256: string; timingResultMd5: string;
  rejectedImageSha256: string }>
