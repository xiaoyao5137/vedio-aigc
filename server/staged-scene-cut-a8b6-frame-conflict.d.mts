export interface A8B6FrameConflictVerification {
  receiptSha256: string
  receipt: {
    sourceImageSha256: string
    sourceImageUrl: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export function assertA8B6ConflictReviewHop(parent: unknown, current: unknown,
  parentMd5: string, signed: A8B6FrameConflictVerification,
  phase?: 'pending' | 'running' | 'rejected' | 'approved'): boolean
export function verifyA8B6FrameConflictReceipt(planId: string,
  root?: string): Promise<A8B6FrameConflictVerification>
