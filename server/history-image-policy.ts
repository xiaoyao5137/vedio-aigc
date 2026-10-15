type ImageRequest = {
  model?: { provider: string; capability: string }
  executionContext?: { workflowId?: string; nodeId?: string }
}

export function isHistoricalImageWorkflow(request: ImageRequest) {
  return request.executionContext?.workflowId === 'wf-sanguo-history-drama'
}

export function assertHistoricalImageProvider(request: ImageRequest) {
  const codexSceneCutOpening = request.executionContext?.nodeId === 'sanguo-scene-cut-first-frame'
    && request.model?.provider === 'Codex'
  if (isHistoricalImageWorkflow(request) && request.model?.capability === 'image'
    && request.model.provider !== 'Kling' && !codexSceneCutOpening) {
    throw new Error('HISTORY_IMAGE_PROVIDER_REQUIRED: 历史视频生图仅允许可灵，请将图片节点切换到可灵生图。')
  }
}
