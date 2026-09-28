import { callAnthropicText, resolveAnthropicTextConfig } from './anthropic-text.ts'
import type { ExternalModelConfig } from './model-adapters.ts'
import { loadReviewImages, reviewImageContentBlocks, type LoadedReviewImage } from './review-images.ts'

export type RemoteTextDependencies = NonNullable<Parameters<typeof callAnthropicText>[3]> & { root?: string }

function remoteTextProtocol(model: ExternalModelConfig): string | undefined {
  return model.settings.apiProtocol || (model.provider === 'Anthropic' ? 'anthropic-messages' : undefined)
}

/** The provider identifies the model vendor; gateways require an explicit wire protocol. */
export function supportsRemoteText(model: ExternalModelConfig): boolean {
  return model.capability === 'text'
    && ['Anthropic', 'OpenAI', 'Custom'].includes(model.provider)
    && remoteTextProtocol(model) === 'anthropic-messages'
}

/** Shared by model experience and workflows. A supplied snapshot is the exact
 * evidence already fingerprinted by the caller and must never be reloaded. */
export async function callRemoteText(
  model: ExternalModelConfig,
  prompt: string,
  params: Record<string, unknown> = {},
  operation?: string,
  frames?: readonly LoadedReviewImage[],
  dependencies: RemoteTextDependencies = {},
) {
  if (!supportsRemoteText(model)) {
    throw new Error(`REMOTE_TEXT_PROTOCOL_UNSUPPORTED: provider=${model.provider}, capability=${model.capability}, apiProtocol=${remoteTextProtocol(model) ?? 'unset'}；文本接口须显式配置受支持的协议`)
  }
  // Reject invalid sampling/output parameters before reading evidence or submitting.
  const configured = resolveAnthropicTextConfig(model, params)
  const snapshot = frames ?? await loadReviewImages(params.reviewImages, dependencies.root ?? process.cwd(), params.reviewImageDetail)
  if (!snapshot.length && Array.isArray(params.reviewImages) && params.reviewImages.length) {
    throw new Error('REVIEW_IMAGES_INVALID: 已提供原帧地址，但审查快照为空；不能静默丢弃图像')
  }
  const images = reviewImageContentBlocks(snapshot)
  const rawLimit = params.primaryTransportAttempts
  const maxAttemptsBeforeFailover = rawLimit === undefined ? undefined : Number(rawLimit)
  if (maxAttemptsBeforeFailover !== undefined && (!Number.isSafeInteger(maxAttemptsBeforeFailover) || maxAttemptsBeforeFailover < 1 || maxAttemptsBeforeFailover > 20)) {
    throw new Error('REMOTE_TEXT_CONFIG_INVALID: primaryTransportAttempts 必须为 1–20 的整数')
  }
  const rawAttemptTimeout = params.primaryTransportAttemptTimeoutMs
  const attemptTimeoutMs = rawAttemptTimeout === undefined ? undefined : Number(rawAttemptTimeout)
  if (attemptTimeoutMs !== undefined && (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1_000 || attemptTimeoutMs > 600_000)) {
    throw new Error('REMOTE_TEXT_CONFIG_INVALID: primaryTransportAttemptTimeoutMs 必须为 1000–600000 的整数')
  }
  return callAnthropicText(configured, images.length ? [...images, { type: 'text', text: prompt }] : prompt, operation,
    { ...dependencies, ...(maxAttemptsBeforeFailover === undefined ? {} : { maxAttemptsBeforeFailover }),
      ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }) })
}
