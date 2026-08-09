import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AnalysisDiagnosticEvent, AnalysisProgressEvent } from '../../shared/contracts'
import LoggingView from '../../src/components/LoggingView'
import '../../src/styles.css'

const diagnosticEvents: AnalysisDiagnosticEvent[] = [
  {
    timestamp: '2026-08-09T10:00:00.000Z',
    level: 'info',
    event: 'analysis.started',
    message: 'Analysis started',
    provider: 'cursor',
    stage: 'preparing',
  },
  {
    timestamp: '2026-08-09T10:02:00.000Z',
    level: 'error',
    event: 'provider.failed',
    message: 'Provider returned an error',
    provider: 'cursor',
    stage: 'inspecting',
    taskId: 'task-7',
    metadata: { retryable: true },
  },
]

const liveActivity: AnalysisProgressEvent[] = [
  {
    runId: 'run-1',
    timestamp: '2026-08-09T10:01:00.000Z',
    stage: 'collecting',
    message: 'Collected pull request context',
    taskState: 'complete',
  },
]

describe('LoggingView', () => {
  it('shows summary, metadata, and newest events first', () => {
    render(<LoggingView events={diagnosticEvents} liveActivity={liveActivity} running={false} providerLabel="Cursor" />)

    expect(screen.getByRole('heading', { name: 'Analysis log' })).toBeInTheDocument()
    expect(screen.getByText('Cursor')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()

    const list = screen.getByRole('log', { name: 'Analysis log events' })
    const messages = within(list).getAllByRole('listitem')
    expect(messages[0]).toHaveTextContent('Provider returned an error')
    expect(messages[1]).toHaveTextContent('Collected pull request context')
    expect(messages[2]).toHaveTextContent('Analysis started')
    expect(messages[0]).toHaveTextContent('task-7')
    expect(messages[0]).toHaveTextContent('inspecting')
  })

  it('filters by level and search query and copies only visible entries', async () => {
    const user = userEvent.setup()
    render(<LoggingView events={diagnosticEvents} liveActivity={liveActivity} running={false} providerLabel="Cursor" />)

    await user.click(screen.getByRole('button', { name: /error/i }))
    expect(screen.getByText('Provider returned an error')).toBeInTheDocument()
    expect(screen.queryByText('Analysis started')).not.toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search logs' }), 'task-7')
    expect(screen.getByText('Provider returned an error')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy visible logs' }))
    expect(screen.getByRole('status')).toHaveTextContent('Copied')
  })

  it('communicates loading while a run has not emitted events', () => {
    render(<LoggingView events={[]} liveActivity={[]} running providerLabel="Codex" />)

    expect(screen.getByRole('status')).toHaveTextContent('Waiting for analysis events')
  })

  it('lets the events panel fill the available logging page height', () => {
    render(<LoggingView events={diagnosticEvents} liveActivity={liveActivity} running={false} providerLabel="Cursor" />)

    const page = document.querySelector('.logging-page')
    const activity = screen.getByRole('log', { name: 'Analysis log events' }).closest('.agent-activity')
    const log = screen.getByRole('log', { name: 'Analysis log events' })

    expect(page).not.toBeNull()
    expect(activity).not.toBeNull()
    expect(window.getComputedStyle(page as Element).display).toBe('flex')
    expect(window.getComputedStyle(page as Element).flexDirection).toBe('column')
    expect(window.getComputedStyle(activity as Element).display).toBe('flex')
    expect(window.getComputedStyle(activity as Element).flexDirection).toBe('column')
    expect(window.getComputedStyle(activity as Element).flexGrow).toBe('1')
    expect(window.getComputedStyle(log).maxHeight).toBe('none')
    expect(window.getComputedStyle(log).minHeight).toBe('0')
  })
})
