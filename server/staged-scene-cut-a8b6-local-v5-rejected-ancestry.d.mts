export const A8B6_LOCAL_V5_REJECTED_V4: {
  readonly executionId: string; readonly failedResultMd5: string;
  readonly workflowReviewStatus: string;
  readonly failedModelExecutionId: string;
  readonly failedRequestSha256: string;
  readonly reviewModelExecutionId: string;
  readonly rejectedReviewSha256: string;
  readonly retryModelResponseSha256: string;
  readonly retryIntentSha256: string;
  readonly frameApprovalStatus: string;
  readonly modelLedgerCount: number;
  readonly imageLedgerCount: number;
  readonly soleIssueCode: string }
export function assertA8B6LocalV5RejectedV4State(state: unknown,
  resultMd5: string, timing: unknown, timingResultMd5: string,
  signed: unknown, modelLedgers: unknown[], intentBytes: Buffer,
  root?: string): typeof A8B6_LOCAL_V5_REJECTED_V4
export function verifyA8B6LocalV5RejectedV4Ancestry(root?: string): Promise<{
  rejected: typeof A8B6_LOCAL_V5_REJECTED_V4;
  sourceReceiptSha256: string; timingResultMd5: string;
  rejectedImageSha256: string }>
