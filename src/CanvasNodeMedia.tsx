import { memo, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { AudioLines, ChevronLeft, ChevronRight, ExternalLink, Film, ImageIcon, LoaderCircle, Maximize2, TriangleAlert } from 'lucide-react'
import type { CanvasMedia } from './canvas-media'
import './canvas-node-media.css'

type MediaKind = CanvasMedia['kind']
type MediaSource = CanvasMedia['source']

type CanvasNodeMediaProps = {
  items: CanvasMedia[]
  kind?: MediaKind
  status?: string
  nodeTitle: string
  onPreview?: (item: CanvasMedia) => void
}

const kindLabels: Record<MediaKind, string> = { image: '图片', video: '视频', audio: '音频' }
const sourceLabels: Record<MediaSource, string> = { output: '本次生成', reference: '引用素材' }

function stopCanvasEvent(event: SyntheticEvent) {
  event.stopPropagation()
}

function safeMediaUrl(item: CanvasMedia) {
  const url = item.url.trim()
  if (!url || Array.from(url).some(character => character.charCodeAt(0) < 32)) return undefined
  if (/^(https?:|blob:)/i.test(url)) return url
  if (/^data:/i.test(url)) return new RegExp(`^data:${item.kind}/`, 'i').test(url) ? url : undefined
  if (!/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith('//') && !url.startsWith('\\')) return url
  return undefined
}

function itemKey(item: CanvasMedia) {
  return `${item.source}:${item.kind}:${item.url}`
}

function MediaIcon({ kind, size = 22 }: { kind?: MediaKind; size?: number }) {
  if (kind === 'video') return <Film size={size} aria-hidden="true" />
  if (kind === 'audio') return <AudioLines size={size} aria-hidden="true" />
  return <ImageIcon size={size} aria-hidden="true" />
}

function EmptyMedia({ kind, source, status }: { kind?: MediaKind; source: MediaSource; status?: string }) {
  const running = ['running', 'generating', 'processing'].includes(status ?? '')
  const failed = ['failed', 'error'].includes(status ?? '')
  const completed = ['success', 'completed', 'succeeded'].includes(status ?? '')
  const stopped = ['cancelled', 'canceled', 'stopped'].includes(status ?? '')
  const skipped = status === 'skipped'
  const mediaLabel = kind ? kindLabels[kind] : '媒体'
  const title = source === 'reference' ? '暂无引用素材'
    : running ? `正在生成${mediaLabel}`
      : failed ? '本次生成失败'
        : stopped ? '生成已停止'
          : skipped ? '本轮已跳过'
            : completed ? '暂无可预览媒体' : `等待生成${mediaLabel}`
  const detail = source === 'reference' ? '配置引用素材后即可预览'
    : running ? '生成完成后在这里显示'
      : failed ? '可在节点详情中查看失败原因'
        : stopped ? '尚无可预览的生成结果'
          : skipped ? '本轮未执行此节点'
            : completed ? '结果中未找到可预览的媒体链接' : '执行此节点后在这里显示'

  return <div className={`canvas-media-empty${running && source === 'output' ? ' is-generating' : ''}`} role="status">
    {running && source === 'output' ? <LoaderCircle className="canvas-media-spinner" size={22} aria-hidden="true" />
      : failed && source === 'output' ? <TriangleAlert size={22} aria-hidden="true" /> : <MediaIcon kind={kind} />}
    <span className="canvas-media-empty-title">{title}</span>
    <span className="canvas-media-empty-detail">{detail}</span>
  </div>
}

function MediaPlayer({ item, nodeTitle, onPreview }: { item: CanvasMedia; nodeTitle: string; onPreview?: (item: CanvasMedia) => void }) {
  const [failed, setFailed] = useState(false)
  const url = safeMediaUrl(item)
  const title = item.label || `${nodeTitle} · ${kindLabels[item.kind]}`
  if (!url || failed) return <div className="canvas-media-empty canvas-media-error" role="status">
    <TriangleAlert size={22} aria-hidden="true" />
    <span className="canvas-media-empty-title">{url ? '媒体暂时无法加载' : '暂无可用的媒体地址'}</span>
    <span className="canvas-media-empty-detail">{url && !/^data:/i.test(url) ? '可点击下方图标打开原文件' : '请在节点详情中检查素材'}</span>
  </div>

  if (item.kind === 'video') return <video className="canvas-media-video" src={url} controls playsInline preload="metadata" aria-label={title} onError={() => setFailed(true)} />
  if (item.kind === 'audio') return <div className="canvas-media-audio">
    <AudioLines size={30} aria-hidden="true" />
    <span>音频试听</span>
    <audio src={url} controls preload="metadata" aria-label={title} onError={() => setFailed(true)} />
  </div>

  const canOpen = !/^data:/i.test(url)
  const content = <><img src={url} alt={title} loading="lazy" decoding="async" onError={() => setFailed(true)} />{(onPreview || canOpen) && <span className="canvas-media-expand"><Maximize2 size={13} aria-hidden="true" />查看大图</span>}</>
  if (onPreview) return <button className="canvas-media-image" type="button" aria-label={`查看大图：${title}`} onClick={() => onPreview(item)}>{content}</button>
  if (canOpen) return <a className="canvas-media-image" href={url} target="_blank" rel="noopener noreferrer" aria-label={`打开图片：${title}`}>{content}</a>
  return <div className="canvas-media-image is-static">{content}</div>
}

/** A fixed-size media surface shared by workflow detail, editor and execution cards. */
export const CanvasNodeMedia = memo(function CanvasNodeMedia({ items, kind, status, nodeTitle, onPreview }: CanvasNodeMediaProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const mediaGestureRef = useRef({ pointer: false, mouse: false })
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const [selection, setSelection] = useState<{ source: MediaSource; key?: string } | null>(null)
  const outputs = items.filter(item => item.source === 'output')
  const references = items.filter(item => item.source === 'reference')
  // A new output replaces the default reference preview, while an explicit user choice stays selected.
  const source = selection?.source ?? (outputs.length ? 'output' : references.length ? 'reference' : 'output')
  const sourceItems = source === 'output' ? outputs : references
  const selectedIndex = Math.max(0, sourceItems.findIndex(item => itemKey(item) === selection?.key))
  const selected = sourceItems[selectedIndex]
  const selectedUrl = selected && safeMediaUrl(selected)
  const originalUrl = selectedUrl && !/^data:/i.test(selectedUrl) ? selectedUrl : undefined

  useEffect(() => {
    const element = rootRef.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '180px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const selectRelative = (offset: number) => {
    const next = sourceItems[(selectedIndex + offset + sourceItems.length) % sourceItems.length]
    if (next) setSelection({ source, key: itemKey(next) })
  }

  const startMediaGesture = (event: SyntheticEvent, type: 'pointer' | 'mouse') => {
    mediaGestureRef.current[type] = true
    event.stopPropagation()
  }
  const continueMediaGesture = (event: SyntheticEvent, type: 'pointer' | 'mouse', ended = false) => {
    // Let a drag that started on the node header finish when released over the preview.
    if (mediaGestureRef.current[type]) event.stopPropagation()
    if (ended) mediaGestureRef.current[type] = false
  }

  return <div ref={rootRef} className="canvas-node-media" data-canvas-media="true" role="group" aria-label={`${nodeTitle}媒体预览`}
    onClick={stopCanvasEvent} onDoubleClick={stopCanvasEvent}
    onPointerDown={event => startMediaGesture(event, 'pointer')} onMouseDown={event => startMediaGesture(event, 'mouse')}
    onPointerMove={event => continueMediaGesture(event, 'pointer')} onMouseMove={event => continueMediaGesture(event, 'mouse')}
    onPointerUp={event => continueMediaGesture(event, 'pointer', true)} onMouseUp={event => continueMediaGesture(event, 'mouse', true)}
    onPointerCancel={event => continueMediaGesture(event, 'pointer', true)}
    onPointerLeave={() => { mediaGestureRef.current.pointer = false }} onMouseLeave={() => { mediaGestureRef.current.mouse = false }}
    onTouchStart={stopCanvasEvent} onKeyDown={stopCanvasEvent} onKeyUp={stopCanvasEvent} onWheel={stopCanvasEvent}>
    <div className="canvas-media-sources" role="group" aria-label="媒体来源">
      {(['output', 'reference'] as const).map(value => <button key={value} type="button" aria-pressed={source === value} onClick={() => setSelection({ source: value })}>
        {sourceLabels[value]}<span>{value === 'output' ? outputs.length : references.length}</span>
      </button>)}
    </div>
    <div className="canvas-media-stage">
      {!selected ? <EmptyMedia kind={kind} status={status} source={source} />
        : visible ? <MediaPlayer key={itemKey(selected)} item={selected} nodeTitle={nodeTitle} onPreview={onPreview} />
          : <div className="canvas-media-empty"><MediaIcon kind={selected.kind} /><span className="canvas-media-empty-detail">移至此处查看{kindLabels[selected.kind]}</span></div>}
    </div>
    <div className="canvas-media-footer">
      <span className="canvas-media-caption" title={selected?.label}>{selected?.label || (selected ? kindLabels[selected.kind] : kind ? `${kindLabels[kind]}预览` : '媒体预览')}</span>
      {sourceItems.length > 1 && <div className="canvas-media-pagination" aria-label="切换预览素材">
        <button type="button" aria-label="上一份素材" onClick={() => selectRelative(-1)}><ChevronLeft size={13} /></button>
        <span aria-live="polite">{selectedIndex + 1}/{sourceItems.length}</span>
        <button type="button" aria-label="下一份素材" onClick={() => selectRelative(1)}><ChevronRight size={13} /></button>
      </div>}
      {selected?.kind === 'video' && selectedUrl && onPreview && <button className="canvas-media-enlarge" type="button" aria-label="放大查看视频" title="放大查看视频" onClick={() => { rootRef.current?.querySelector('video')?.pause(); onPreview(selected) }}><Maximize2 size={13} aria-hidden="true" /></button>}
      {originalUrl && <a className="canvas-media-original" href={originalUrl} target="_blank" rel="noopener noreferrer" aria-label="打开原文件" title="打开原文件"><ExternalLink size={13} aria-hidden="true" /></a>}
    </div>
  </div>
})
