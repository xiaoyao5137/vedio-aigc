type WorkflowMediaRequest = {
  model: { capability: string }
  params?: Record<string, unknown>
  executionContext?: { workflowId?: string; nodeId?: string }
}

function requiredMediaUrl(value: unknown) {
  return typeof value === 'string' && Boolean(value.trim())
}

/** Last line of defence before a paid Sanguo video request leaves the server. */
export function validateWorkflowMediaContract(request: WorkflowMediaRequest) {
  if (request.executionContext?.workflowId !== 'wf-sanguo-history-drama'
    || request.executionContext?.nodeId !== 'sanguo-video'
    || request.model.capability !== 'video') return
  const params = request.params ?? {}
  const missing: string[] = []
  if (!requiredMediaUrl(params.endImage)) missing.push('目标尾帧 endImage')
  if (Number(params.duration) !== 15) missing.push('固定时长 duration=15')
  if (missing.length) {
    throw new Error(`三国短剧视频请求不完整：缺少 ${missing.join('、')}；已阻止绕过目标尾帧工作流直接生成视频`)
  }
}
