import { AnimatePresence, motion, type HTMLMotionProps } from 'framer-motion'
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react'

/** Заголовок строки настроек: переключатели и списки внутри берут его как подпись для экранного диктора. */
const RowLabel = createContext<string | undefined>(undefined)

export const spring = { type: 'spring', stiffness: 520, damping: 34, mass: 0.8 } as const
export const softSpring = { type: 'spring', stiffness: 260, damping: 28 } as const

type ButtonProps = HTMLMotionProps<'button'> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'success'
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
  loading?: boolean
}

export function Button({ variant = 'default', size = 'md', icon, loading, children, className = '', disabled, ...rest }: ButtonProps) {
  const cls = ['btn', variant !== 'default' && `btn-${variant}`, size !== 'md' && `btn-${size}`, className].filter(Boolean).join(' ')
  return (
    <motion.button
      className={cls}
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      transition={spring}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" style={{ width: 16, height: 16 }} /> : icon}
      {children as ReactNode}
    </motion.button>
  )
}

export function IconButton({ label, children, ...rest }: HTMLMotionProps<'button'> & { label: string }) {
  return (
    <motion.button
      className="btn btn-ghost icon-btn no-drag"
      aria-label={label}
      title={label}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.9 }}
      transition={spring}
      {...rest}
    >
      {children as ReactNode}
    </motion.button>
  )
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  const rowLabel = useContext(RowLabel)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? rowLabel}
      disabled={disabled}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <motion.span className="switch-knob" initial={false} animate={{ x: checked ? 18 : 0 }} transition={spring} />
    </button>
  )
}

/** Ползунок: заполненная часть подсвечена акцентом (CSS-переменная --fill). */
export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  disabled
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  label?: string
  disabled?: boolean
}) {
  const rowLabel = useContext(RowLabel)
  const fill = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      className="slider"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label ?? rowLabel}
      style={{ ['--fill' as string]: `${fill}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className={`segmented ${disabled ? 'disabled' : ''}`} role="radiogroup" aria-disabled={disabled || undefined}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={disabled}
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            // Стрелки — как у обычной группы переключателей.
            const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
            if (!dir) return
            e.preventDefault()
            const i = options.findIndex((x) => x.value === value)
            const next = options[(i + dir + options.length) % options.length]
            onChange(next.value)
            const btns = (e.currentTarget.parentElement?.querySelectorAll('button') ?? []) as NodeListOf<HTMLButtonElement>
            btns[(i + dir + options.length) % options.length]?.focus()
          }}
        >
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={spring} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string | number>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  const rowLabel = useContext(RowLabel)
  return (
    <select
      className="select"
      aria-label={rowLabel}
      value={String(value)}
      onChange={(e) => {
        const opt = options.find((o) => String(o.value) === e.target.value)
        if (opt) onChange(opt.value)
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/**
 * Плавно раскрывающийся блок: высота анимируется с обрезкой содержимого, чтобы соседние строки
 * не наезжали друг на друга. Свёрнутый блок не попадает в порядок Tab.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className={`collapse ${className ?? ''}`}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ height: { type: 'spring', stiffness: 320, damping: 34 }, opacity: { duration: 0.18 } }}
          style={{ overflow: 'hidden' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Последнее непустое значение: модальное окно показывает содержимое и во время анимации закрытия. */
export function useLastNonNull<T>(value: T | null | undefined): T | null | undefined {
  const ref = useRef(value)
  if (value) ref.current = value
  return value ?? ref.current
}

export function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="row" role="group" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="row-text">
        <div className="row-title">{title}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <RowLabel.Provider value={typeof title === 'string' ? title : undefined}>{children}</RowLabel.Provider>
    </div>
  )
}

/** Аватар с цветом, стабильно вычисленным из ника. */
export function Avatar({ name, size = 42 }: { name: string; size?: number }) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        flexBasis: size,
        fontSize: size * 0.38,
        background: `linear-gradient(135deg, hsl(${h} 75% 60%), hsl(${(h + 40) % 360} 70% 50%))`
      }}
    >
      {initials || '?'}
    </div>
  )
}

export function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Esc закрывает, фокус переходит внутрь окна и возвращается обратно после закрытия.
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') return closeRef.current()
      // Tab не уходит за пределы окна на страницу под затемнением.
      if (e.key !== 'Tab' || !ref.current) return
      const items = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex]:not([tabindex="-1"])')]
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (!ref.current.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('button, input, [tabindex]')?.focus())
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [open])
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            className="modal"
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={softSpring}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Контейнер для поочерёдного появления дочерних элементов. */
export const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } }
}

export const riseIn = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: softSpring }
}
