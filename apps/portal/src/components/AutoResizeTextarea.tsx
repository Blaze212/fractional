import { useLayoutEffect, useRef } from 'react'

// A textarea that grows to fit its content so all text is visible without
// scrolling. Recomputes height whenever the value changes.
export function AutoResizeTextarea({
  value,
  className,
  ...props
}: React.ComponentProps<'textarea'>) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      className={`resize-none overflow-hidden ${className ?? ''}`}
      {...props}
    />
  )
}
