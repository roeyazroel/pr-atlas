import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

export interface SelectMenuOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectMenuProps {
  ariaLabel: string
  value: string
  options: SelectMenuOption[]
  onChange: (value: string) => void
  className?: string
  placeholder?: string
  searchable?: boolean
}

export function SelectMenu({ ariaLabel, value, options, onChange, className, placeholder, searchable = false }: SelectMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const selectedOption = options.find((option) => option.value === value)
  const visibleIndexes = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
    return options.flatMap((option, index) => {
      if (!normalizedQuery) return [index]
      return `${option.label} ${option.value}`.toLocaleLowerCase().includes(normalizedQuery)
        ? [index]
        : []
    })
  }, [options, searchQuery])
  const availableIndexes = visibleIndexes.filter((index) => !options[index].disabled)
  const activeOption = activeIndex === null ? undefined : options[activeIndex]
  const activeOptionId = activeOption && !activeOption.disabled ? `${listboxId}-option-${activeIndex}` : undefined
  const displayLabel = selectedOption?.label ?? placeholder ?? 'Select…'

  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
  const firstAvailable = availableIndexes[0]
  const initialIndex = selectedIndex >= 0 ? selectedIndex : (firstAvailable ?? null)

  const closeMenu = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const moveActive = (direction: 1 | -1) => {
    if (!availableIndexes.length) return
    setActiveIndex((current) => {
      const foundPosition = current === null ? -1 : availableIndexes.indexOf(current)
      const currentPosition = foundPosition >= 0 ? foundPosition : (direction === 1 ? -1 : availableIndexes.length)
      const nextPosition = (currentPosition + direction + availableIndexes.length) % availableIndexes.length
      return availableIndexes[nextPosition]
    })
  }

  const selectActive = () => {
    if (activeIndex === null) return
    const option = options[activeIndex]
    if (!option || option.disabled) return
    onChange(option.value)
    closeMenu(true)
  }

  const openMenu = (direction?: 1 | -1) => {
    setSearchQuery('')
    setActiveIndex(direction === -1 ? (availableIndexes.at(-1) ?? null) : initialIndex)
    setOpen(true)
  }

  useEffect(() => {
    if (open) {
      if (searchable) searchInputRef.current?.focus()
      else listboxRef.current?.focus()
      setActiveIndex((current) => {
        if (current !== null && options[current] && !options[current].disabled) return current
        return initialIndex
      })
    }
  }, [open, options, initialIndex, searchable])

  useEffect(() => {
    if (!open) return
    setActiveIndex((current) => {
      if (current !== null && availableIndexes.includes(current)) return current
      return availableIndexes[0] ?? null
    })
  }, [availableIndexes, open])

  useEffect(() => {
    if (!open || activeIndex === null) return
    document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, listboxId, open])

  useEffect(() => {
    if (!open) return undefined
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeMenu()
    }
    document.addEventListener('pointerdown', handleOutsidePointerDown)
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown)
  }, [open])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const searchInputHasFocus = event.currentTarget === searchInputRef.current
    if (event.key === 'Tab') {
      if (open && event.shiftKey) {
        event.preventDefault()
        closeMenu(true)
      }
      return
    }
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault()
        closeMenu(true)
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      if (!open) openMenu(direction)
      else moveActive(direction)
      return
    }
    if (event.key === 'Enter' || (!searchInputHasFocus && (event.key === ' ' || event.key === 'Space' || event.key === 'Spacebar'))) {
      event.preventDefault()
      if (!open) openMenu()
      else selectActive()
    }
  }

  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const nextFocused = event.relatedTarget
    if (!(nextFocused instanceof Node) || !event.currentTarget.contains(nextFocused)) closeMenu()
  }

  return <div ref={rootRef} className={['select-menu', className].filter(Boolean).join(' ')} onBlur={handleBlur}>
    <button
      ref={triggerRef}
      type="button"
      className="select-menu-trigger"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      onClick={() => open ? closeMenu() : openMenu()}
      onKeyDown={handleKeyDown}
    >
      <span className="select-menu-value">{displayLabel}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className="select-menu-popover">
      {searchable && <div className="select-menu-search"><input
        ref={searchInputRef}
        type="search"
        role="combobox"
        aria-label="Search models"
        aria-controls={listboxId}
        aria-expanded="true"
        aria-activedescendant={activeOptionId}
        placeholder="Search models…"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Escape' || event.key === 'Enter') handleKeyDown(event)
          event.stopPropagation()
        }}
      /></div>}
      <div
        ref={listboxRef}
        id={listboxId}
        role="listbox"
        tabIndex={-1}
        aria-label={`${ariaLabel} options`}
        aria-activedescendant={searchable ? undefined : activeOptionId}
        className="select-menu-listbox"
        onKeyDown={handleKeyDown}
      >
      {visibleIndexes.map((index) => {
        const option = options[index]
        return <div
        id={`${listboxId}-option-${index}`}
        key={`${option.value}-${index}`}
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled || undefined}
        data-active={activeIndex === index ? 'true' : undefined}
        className={['select-menu-option', option.disabled ? 'disabled' : ''].filter(Boolean).join(' ')}
        onClick={() => {
          if (!option.disabled) {
            onChange(option.value)
            closeMenu(true)
          }
        }}
      >{option.label}</div>
      })}
      {searchable && !visibleIndexes.length && <p className="select-menu-empty">No matching models.</p>}
      </div>
    </div>}
  </div>
}

export default SelectMenu
