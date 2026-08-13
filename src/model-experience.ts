export type ExperienceValue = string | boolean | string[]

export type ExperienceMediaKind = 'image' | 'video' | 'audio'

export type ExperienceMedia = {
  url: string
  kind: ExperienceMediaKind
  filename: string
}

export type ExperienceResponseInspection = {
  taskId?: string
  providerStatus?: string
  message?: string
  media: ExperienceMedia[]
  pending: boolean
  succeeded: boolean
  failed: boolean
}

export type ExperienceField = {
  key: string
  label: string
  apiName: string
  group: 'input' | 'generation' | 'advanced'
  control: 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'json' | 'image' | 'images'
  defaultValue: ExperienceValue
  required: false
  options?: Array<{ label: string; value: string }>
  min?: number
  max?: number
  step?: number
  placeholder?: string
  help?: string
}

type ExperienceModel = {
  provider: string
  capability: string
  settings: Record<string, string>
}

type ExperienceRequestData = {
  prompt?: unknown
  params?: unknown
}

export type ExperienceRequestRestore = {
  prompt: string
  values: Record<string, ExperienceValue>
  omittedFields: string[]
}

const pendingStatuses = new Set(['created', 'submitted', 'pending', 'queued', 'processing', 'running'])
const successStatuses = new Set(['success', 'succeed', 'succeeded', 'completed', 'complete', 'ready', 'simulated'])
const failedStatuses = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled'])

function responseRecords(value: unknown, records: Array<Record<string, unknown>> = []) {
  if (!value || typeof value !== 'object') return records
  if (Array.isArray(value)) {
    value.forEach((item) => responseRecords(item, records))
    return records
  }
  const record = value as Record<string, unknown>
  records.push(record)
  Object.values(record).forEach((item) => responseRecords(item, records))
  return records
}

function firstResponseString(records: Array<Record<string, unknown>>, keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return undefined
}

function mediaKind(url: string, path: string, fallback: ExperienceMediaKind): ExperienceMediaKind | undefined {
  const dataMime = url.match(/^data:(image|video|audio)\//i)?.[1]?.toLowerCase()
  if (dataMime === 'image' || dataMime === 'video' || dataMime === 'audio') return dataMime
  const cleanUrl = url.split(/[?#]/)[0].toLowerCase()
  if (/\.(png|jpe?g|webp|gif|avif|bmp)$/.test(cleanUrl)) return 'image'
  if (/\.(mp4|webm|mov|m4v|mkv)$/.test(cleanUrl)) return 'video'
  if (/\.(mp3|wav|aac|flac|opus|m4a|ogg)$/.test(cleanUrl)) return 'audio'
  const hint = path.toLowerCase()
  const key = hint.split('.').pop() ?? ''
  if (/image|images|picture|pictures|thumbnail|poster|cover|first_frame|last_frame|tail_frame/.test(key)) return 'image'
  if (/audio|audios|speech/.test(key)) return 'audio'
  if (/video|videos/.test(key) || /(^|\.)videos?\.\d+\.url$/.test(hint)) return 'video'
  return /^https?:\/\//i.test(url) && (key === 'url' || key === 'media_url') ? fallback : undefined
}

function mediaFilename(kind: ExperienceMediaKind, index: number, url: string) {
  const pathName = url.startsWith('data:') ? '' : url.split(/[?#]/)[0].split('/').pop() ?? ''
  if (pathName && /\.[a-z0-9]{2,5}$/i.test(pathName)) return decodeURIComponent(pathName)
  const extension = kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'
  return `model-result-${index + 1}.${extension}`
}

export function inspectExperienceResponse(body: unknown, capability: ExperienceMediaKind | 'text'): ExperienceResponseInspection {
  const records = responseRecords(body)
  const taskId = firstResponseString(records, ['task_id', 'taskId'])
  const providerStatus = firstResponseString(records, ['task_status', 'taskStatus', 'status'])
  const message = firstResponseString(records, ['task_status_msg', 'taskStatusMessage', 'message', 'error'])
  const normalizedStatus = providerStatus?.toLowerCase() ?? ''
  const fallback = capability === 'text' ? 'image' : capability
  const found: Array<{ url: string; kind: ExperienceMediaKind }> = []
  const visit = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      const kind = mediaKind(value, path, fallback)
      if (kind) found.push({ url: value, kind })
      return
    }
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}.${index}`))
    if (value && typeof value === 'object') {
      Object.entries(value as Record<string, unknown>).forEach(([key, item]) => visit(item, path ? `${path}.${key}` : key))
    }
  }
  visit(body, '')
  const unique = [...new Map(found.map((item) => [item.url, item])).values()]
  const matching = capability === 'text' ? unique : unique.filter((item) => item.kind === capability)
  const media = matching.map((item, index) => ({ ...item, filename: mediaFilename(item.kind, index, item.url) }))
  const failed = failedStatuses.has(normalizedStatus)
  const pending = Boolean(taskId && pendingStatuses.has(normalizedStatus))
  const succeeded = successStatuses.has(normalizedStatus) || (!failed && !pending && media.length > 0)
  return { taskId, providerStatus, message, media, pending, succeeded, failed }
}

const option = (value: string, label = value) => ({ value, label })
const optionalFields = (fields: Array<Omit<ExperienceField, 'required'>>): ExperienceField[] =>
  fields.map((field) => ({ ...field, required: false }))

export function modelExperienceFields(model: ExperienceModel): ExperienceField[] {
  const settings = model.settings

  if (model.provider === 'Kling' && model.capability === 'video') {
    return optionalFields([
      {
        key: 'referenceImage', label: '首帧参考图', apiName: 'image', group: 'input', control: 'image', defaultValue: '',
        placeholder: '也可粘贴公开图片 URL 或 data:image/...;base64,...', help: '上传本地图片或填写图片地址后调用图生视频；留空时调用文生视频。',
      },
      {
        key: 'endImage', label: '尾帧参考图', apiName: 'image_tail', group: 'input', control: 'image', defaultValue: '',
        placeholder: '也可粘贴公开图片 URL 或 data:image/...;base64,...', help: '上传本地图片或填写图片地址；仅图生视频生效，用于约束最后一帧。',
      },
      {
        key: 'referenceImages', label: '参考附件', apiName: 'image_list', group: 'input', control: 'images', defaultValue: [],
        help: '最多上传 7 张人物、物品、场景或风格参考图。上传后可在提示词中使用 @参考附件1、@参考附件2 引用。',
      },
      { key: 'duration', label: '时长（秒）', apiName: 'duration', group: 'generation', control: 'number', defaultValue: settings.duration || '5', min: 3, max: 15, step: 1, help: 'Kling 3.0 支持 3-15 秒。' },
      { key: 'aspectRatio', label: '画幅比例', apiName: 'aspect_ratio', group: 'generation', control: 'select', defaultValue: settings.aspectRatio || settings.aspect_ratio || '16:9', options: [option('16:9', '横屏 16:9'), option('9:16', '竖屏 9:16'), option('1:1', '方形 1:1')], help: '文生视频生效；图生视频沿用首帧画幅。' },
      { key: 'mode', label: '生成模式', apiName: 'mode', group: 'generation', control: 'select', defaultValue: settings.mode || 'std', options: [option('std', '标准 std'), option('pro', '高品质 pro')] },
      { key: 'sound', label: '原生音频', apiName: 'sound', group: 'generation', control: 'select', defaultValue: settings.sound || 'off', options: [option('off', '关闭'), option('on', '开启')] },
      { key: 'negativePrompt', label: '负向提示词', apiName: 'negative_prompt', group: 'generation', control: 'textarea', defaultValue: settings.negativePrompt || settings.negative_prompt || '', placeholder: '例如：画面闪烁、人物变形、字幕' },
      { key: 'cfgScale', label: '提示词引导强度', apiName: 'cfg_scale', group: 'generation', control: 'number', defaultValue: settings.cfgScale || settings.cfg_scale || '0.5', min: 0, max: 1, step: 0.1 },
      { key: 'multiShot', label: '多镜头叙事', apiName: 'multi_shot', group: 'advanced', control: 'checkbox', defaultValue: false, help: '开启后可由模型自动分镜，或使用自定义分镜。' },
      { key: 'shotType', label: '分镜方式', apiName: 'shot_type', group: 'advanced', control: 'select', defaultValue: 'intelligence', options: [option('intelligence', '智能分镜'), option('customize', '自定义分镜')] },
      { key: 'multiPrompt', label: '自定义分镜', apiName: 'multi_prompt', group: 'advanced', control: 'json', defaultValue: '[]', placeholder: '[{"index":1,"prompt":"远景建立环境","duration":3}]', help: 'JSON 数组；仅开启多镜头并选择自定义分镜时发送。' },
      { key: 'cameraControl', label: '运镜控制', apiName: 'camera_control', group: 'advanced', control: 'json', defaultValue: '', placeholder: '{"type":"simple","config":{"horizontal":0,"vertical":0,"zoom":0}}' },
      { key: 'staticMask', label: '静态笔刷蒙版', apiName: 'static_mask', group: 'advanced', control: 'textarea', defaultValue: '', placeholder: '蒙版图片 URL 或 base64', help: '仅图生视频生效。' },
      { key: 'dynamicMasks', label: '动态笔刷轨迹', apiName: 'dynamic_masks', group: 'advanced', control: 'json', defaultValue: '', placeholder: '[{"mask":"...","trajectories":[{"x":100,"y":120}]}]', help: 'JSON 数组；仅图生视频生效。' },
      { key: 'callbackUrl', label: '回调地址', apiName: 'callback_url', group: 'advanced', control: 'text', defaultValue: '', placeholder: 'https://example.com/kling/callback' },
      { key: 'externalTaskId', label: '外部任务 ID', apiName: 'external_task_id', group: 'advanced', control: 'text', defaultValue: '', placeholder: '用于业务侧幂等和追踪' },
    ])
  }

  if (model.provider === 'Kling' && model.capability === 'image') {
    return optionalFields([
      { key: 'referenceImage', label: '参考图', apiName: 'image', group: 'input', control: 'textarea', defaultValue: '', placeholder: '公开图片 URL 或 data:image/...;base64,...' },
      { key: 'resolution', label: '分辨率', apiName: 'resolution', group: 'generation', control: 'select', defaultValue: settings.resolution || '1k', options: [option('1k', '1K'), option('2k', '2K')] },
      { key: 'aspectRatio', label: '画幅比例', apiName: 'aspect_ratio', group: 'generation', control: 'select', defaultValue: settings.aspectRatio || settings.aspect_ratio || '9:16', options: [option('16:9', '横屏 16:9'), option('9:16', '竖屏 9:16'), option('1:1', '方形 1:1'), option('4:3'), option('3:4'), option('3:2'), option('2:3'), option('21:9')] },
      { key: 'n', label: '生成数量', apiName: 'n', group: 'generation', control: 'number', defaultValue: settings.n || '1', min: 1, max: 9, step: 1 },
      { key: 'negativePrompt', label: '负向提示词', apiName: 'negative_prompt', group: 'generation', control: 'textarea', defaultValue: settings.negativePrompt || settings.negative_prompt || '', help: '文生图生效；上传参考图时供应商接口不接收该字段。' },
      { key: 'watermarkEnabled', label: '添加水印', apiName: 'watermark_info.enabled', group: 'advanced', control: 'checkbox', defaultValue: settings.watermarkEnabled === 'true' },
    ])
  }

  if ((model.provider === 'OpenAI' || model.provider === 'Ofox') && model.capability === 'image') {
    return optionalFields([
      ...(model.provider === 'Ofox' ? [{ key: 'referenceImages', label: '参考图数组', apiName: 'input_images', group: 'input' as const, control: 'json' as const, defaultValue: '[]', placeholder: '["https://example.com/reference.png"]' }] : []),
      { key: 'size', label: '图片尺寸', apiName: 'size', group: 'generation', control: 'text', defaultValue: settings.size || '1024x1024' },
      { key: 'quality', label: '生成质量', apiName: 'quality', group: 'generation', control: 'select', defaultValue: settings.quality || 'high', options: [option('low'), option('medium'), option('high')] },
      { key: 'n', label: '生成数量', apiName: 'n', group: 'generation', control: 'number', defaultValue: settings.n || '1', min: 1, max: 10, step: 1 },
      { key: 'outputFormat', label: '输出格式', apiName: 'output_format', group: 'generation', control: 'select', defaultValue: settings.outputFormat || settings.output_format || 'png', options: [option('png'), option('jpeg'), option('webp')] },
      { key: 'background', label: '背景', apiName: 'background', group: 'advanced', control: 'select', defaultValue: settings.background || 'auto', options: [option('auto'), option('opaque'), option('transparent')] },
    ])
  }

  if (model.provider === 'OpenAI' && model.capability === 'audio') {
    return optionalFields([
      { key: 'voice', label: '音色', apiName: 'voice', group: 'generation', control: 'text', defaultValue: settings.voice || 'alloy' },
      { key: 'responseFormat', label: '输出格式', apiName: 'response_format', group: 'generation', control: 'select', defaultValue: settings.responseFormat || 'mp3', options: [option('mp3'), option('wav'), option('aac'), option('flac'), option('opus'), option('pcm')] },
      { key: 'speed', label: '语速', apiName: 'speed', group: 'generation', control: 'number', defaultValue: settings.speed || '1', min: 0.25, max: 4, step: 0.05 },
    ])
  }

  if (model.provider === 'Anthropic' && model.capability === 'text') {
    return optionalFields([
      { key: 'maxTokens', label: '最大输出 Token', apiName: 'max_tokens', group: 'generation', control: 'number', defaultValue: settings.maxTokens || '4096', min: 1, step: 1 },
      { key: 'temperature', label: '随机性', apiName: 'temperature', group: 'generation', control: 'number', defaultValue: settings.temperature || '0.3', min: 0, max: 1, step: 0.1 },
    ])
  }

  if (model.provider === 'Local' && model.capability === 'video') {
    return optionalFields([
      { key: 'referenceImage', label: '首帧参考图', apiName: 'image', group: 'input', control: 'textarea', defaultValue: '' },
      { key: 'duration', label: '时长（秒）', apiName: 'duration', group: 'generation', control: 'number', defaultValue: settings.duration || '5', min: 1, step: 1 },
      { key: 'aspectRatio', label: '画幅比例', apiName: 'aspect_ratio', group: 'generation', control: 'select', defaultValue: settings.aspectRatio || '9:16', options: [option('16:9'), option('9:16'), option('1:1')] },
    ])
  }

  return []
}

function isHiddenExecutionValue(value: unknown) {
  return typeof value === 'string' && /^\[内容已隐藏，\d+ 字符\]$/.test(value)
}

export function restoreModelExperienceRequest(model: ExperienceModel, requestData: unknown): ExperienceRequestRestore {
  const request = requestData && typeof requestData === 'object' ? requestData as ExperienceRequestData : {}
  const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
    ? request.params as Record<string, unknown>
    : {}
  const values: Record<string, ExperienceValue> = {}
  const omittedFields: string[] = []

  for (const field of modelExperienceFields(model)) {
    const value = params[field.key]
    if (value === undefined) continue
    if (isHiddenExecutionValue(value) || (Array.isArray(value) && value.some(isHiddenExecutionValue))) {
      omittedFields.push(field.label)
      continue
    }
    if (field.control === 'checkbox') {
      values[field.key] = Boolean(value)
    } else if (field.control === 'images') {
      values[field.key] = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    } else if (field.control === 'json') {
      values[field.key] = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    } else if (typeof value === 'string' || typeof value === 'number') {
      values[field.key] = String(value)
    }
  }

  return {
    prompt: typeof request.prompt === 'string' ? request.prompt : '',
    values,
    omittedFields,
  }
}

export function parseModelExperienceParams(model: ExperienceModel, values: Record<string, ExperienceValue> = {}) {
  const params: Record<string, unknown> = {}
  for (const field of modelExperienceFields(model)) {
    const value = values[field.key] ?? field.defaultValue
    if (typeof value === 'string' && !value.trim()) continue

    if (field.control === 'number') {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error(`${field.label}必须是有效数字`)
      if (field.min !== undefined && number < field.min) throw new Error(`${field.label}不能小于 ${field.min}`)
      if (field.max !== undefined && number > field.max) throw new Error(`${field.label}不能大于 ${field.max}`)
      params[field.key] = number
      continue
    }

    if (field.control === 'images') {
      const images = Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []
      if (images.length) params[field.key] = images
      continue
    }

    if (field.control === 'json') {
      try {
        params[field.key] = typeof value === 'string' ? JSON.parse(value) : value
      } catch {
        throw new Error(`${field.label}必须是有效 JSON`)
      }
      continue
    }

    params[field.key] = value
  }
  if (model.provider === 'Kling' && model.capability === 'video') {
    if (!params.referenceImage) {
      delete params.endImage
      delete params.staticMask
      delete params.dynamicMasks
    } else {
      delete params.aspectRatio
    }
    if (!params.multiShot) {
      delete params.shotType
      delete params.multiPrompt
    } else if (params.shotType !== 'customize') {
      delete params.multiPrompt
    }
  }
  return params
}
