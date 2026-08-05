import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import SelectMenu, { type SelectMenuOption } from '../../src/components/SelectMenu'

const options: SelectMenuOption[] = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'disabled', label: 'Unavailable', disabled: true },
  { value: 'beta', label: 'Beta' },
]

function renderMenu(overrides: Partial<React.ComponentProps<typeof SelectMenu>> = {}) {
  const onChange = vi.fn()
  render(<SelectMenu ariaLabel="Provider" value="alpha" options={options} onChange={onChange} {...overrides} />)
  return { onChange }
}

describe('SelectMenu', () => {
  it('renders a button trigger and opens an accessible listbox without a native select', async () => {
    const user = userEvent.setup()
    renderMenu({ placeholder: 'Choose a provider' })

    const trigger = screen.getByRole('button', { name: 'Provider' })
    expect(trigger).toHaveTextContent('Alpha')
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    await user.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).not.toHaveAttribute('aria-activedescendant')
    expect(screen.getByRole('listbox', { name: 'Provider options' })).toHaveFocus()
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true')
  })

  it('selects an enabled option once and closes the listbox', async () => {
    const user = userEvent.setup()
    const { onChange } = renderMenu()

    await user.click(screen.getByRole('button', { name: 'Provider' }))
    await user.click(screen.getByRole('option', { name: 'Beta' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('beta')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('marks disabled options and ignores clicks on them', async () => {
    const user = userEvent.setup()
    const { onChange } = renderMenu()

    await user.click(screen.getByRole('button', { name: 'Provider' }))
    const disabled = screen.getByRole('option', { name: 'Unavailable' })
    expect(disabled).toHaveAttribute('aria-disabled', 'true')

    await user.click(disabled)

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('navigates enabled options with arrows and selects with Enter or Space', async () => {
    const user = userEvent.setup()
    const { onChange } = renderMenu()
    await user.click(screen.getByRole('button', { name: 'Provider' }))

    const listbox = screen.getByRole('listbox')
    const alpha = screen.getByRole('option', { name: 'Alpha' })
    const beta = screen.getByRole('option', { name: 'Beta' })
    expect(listbox).toHaveAttribute('aria-activedescendant', alpha.id)

    await user.keyboard('{ArrowDown}')
    expect(listbox).toHaveAttribute('aria-activedescendant', beta.id)
    await user.keyboard('{ArrowUp}')
    expect(listbox).toHaveAttribute('aria-activedescendant', alpha.id)
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Space}')

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('beta')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup()
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Provider' })

    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes when clicking outside and safely displays a missing selected value', async () => {
    const user = userEvent.setup()
    const { onChange } = renderMenu({ value: 'missing', placeholder: 'Choose a provider' })
    render(<div data-testid="outside" />)

    const trigger = screen.getByRole('button', { name: 'Provider' })
    expect(trigger).toHaveTextContent('Choose a provider')
    await user.click(trigger)
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await user.click(screen.getByTestId('outside'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes when focus tabs forward or backward without trapping focus', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<>
      <button type="button" data-testid="before">Before</button>
      <SelectMenu ariaLabel="Provider" value="alpha" options={options} onChange={onChange} />
      <button type="button" data-testid="after">After</button>
    </>)

    const trigger = screen.getByRole('button', { name: 'Provider' })
    await user.click(trigger)
    await user.tab()
    expect(screen.getByTestId('after')).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.click(trigger)
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByTestId('before')).toHaveFocus()
  })

  it('scrolls a newly active option into view after arrow navigation', async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })

    try {
      renderMenu()
      await user.click(screen.getByRole('button', { name: 'Provider' }))
      scrollIntoView.mockClear()

      const beta = screen.getByRole('option', { name: 'Beta' })
      await user.keyboard('{ArrowDown}')

      expect(beta).toHaveAttribute('id', screen.getByRole('listbox').getAttribute('aria-activedescendant'))
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    } finally {
      if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: originalScrollIntoView })
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})
