import { createElement, useState, type ReactNode } from 'react'

/** A closed disclosure must not build descendants or mount media decoders. */
export function InspectorDisclosure({ summary, children, defaultOpen = false, className = 'context-row' }: {
  summary: ReactNode
  children: () => ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return createElement('details', {
    className, open,
    onToggle: (event: { target: EventTarget; currentTarget: HTMLDetailsElement }) => {
      if (event.target === event.currentTarget) setOpen(event.currentTarget.open)
    },
  }, createElement('summary', null, summary), open ? children() : null)
}

export const INSPECTOR_PAGE_SIZE = 50

/** Bound mounted rows even when a snapshot contains thousands of array entries. */
export function InspectorEntries({ count, renderEntry }: { count: number; renderEntry: (index: number) => ReactNode }) {
  const [requestedPage, setPage] = useState(0)
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(count / INSPECTOR_PAGE_SIZE) - 1))
  const start = page * INSPECTOR_PAGE_SIZE
  const end = Math.min(count, start + INSPECTOR_PAGE_SIZE)
  return createElement('div', { className: 'context-tree' },
    Array.from({ length: end - start }, (_, index) => renderEntry(start + index)),
    count > INSPECTOR_PAGE_SIZE ? createElement('div', { className: 'inspector-pagination' },
      createElement('button', { type: 'button', disabled: page === 0, onClick: () => setPage(page - 1) }, '上一页'),
      createElement('span', null, `${start + 1}–${end} / ${count}`),
      createElement('button', { type: 'button', disabled: end === count, onClick: () => setPage(page + 1) }, '下一页'),
    ) : null,
  )
}
