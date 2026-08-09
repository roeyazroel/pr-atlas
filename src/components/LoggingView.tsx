import { Activity, AlertCircle, ArrowLeft, Clock3, Copy, LoaderCircle, Search, TriangleAlert } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type { AnalysisDiagnosticEvent, AnalysisDiagnosticLevel, AnalysisProgressEvent } from '../../shared/contracts'

export interface LoggingViewProps {
  events: AnalysisDiagnosticEvent[]
  liveActivity: AnalysisProgressEvent[]
  running: boolean
  providerLabel: string
  onClose?: () => void
}

type LevelFilter = 'all' | 'info' | 'warn' | 'error'
type LogSource = 'diagnostic' | 'activity'

interface LogEntry {
  id: string
  timestamp: string
  level: AnalysisDiagnosticLevel
  event: string
  message: string
  provider?: string
  stage?: string
  taskId?: string
  taskState?: AnalysisProgressEvent['taskState']
  durationMs?: number
  metadata?: Record<string, unknown>
  source: LogSource
}

function display(value: string | null | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback
}

function timestampValue(timestamp: string): number {
  const value = Date.parse(timestamp)
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

function formatTimestamp(timestamp: string): string {
  const value = new Date(timestamp)
  if (!Number.isFinite(value.getTime())) return 'Timestamp unavailable'
  return value.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function metadataText(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null
  try {
    const serialized = JSON.stringify(metadata, null, 2)
    if (!serialized) return null
    return serialized.length > 5_000 ? `${serialized.slice(0, 5_000)}\n… metadata truncated` : serialized
  } catch {
    return 'Metadata could not be displayed safely.'
  }
}

function levelClass(level: AnalysisDiagnosticLevel): string {
  if (level === 'error') return 'active'
  if (level === 'warn') return 'outdated'
  if (level === 'info') return 'resolved'
  return 'disputed'
}

function entrySearchText(entry: LogEntry): string {
  const metadata = metadataText(entry.metadata) ?? ''
  return [
    entry.level,
    entry.event,
    entry.message,
    entry.provider,
    entry.stage,
    entry.taskId,
    entry.taskState,
    metadata,
  ].filter(Boolean).join(' ').toLowerCase()
}

function copyLine(entry: LogEntry): string {
  const metadata = metadataText(entry.metadata)
  const details = [
    entry.provider && `provider=${entry.provider}`,
    entry.stage && `stage=${entry.stage}`,
    entry.taskId && `task=${entry.taskId}`,
    entry.taskState && `taskState=${entry.taskState}`,
    entry.durationMs !== undefined && `duration=${entry.durationMs}ms`,
  ].filter(Boolean).join(' ')
  return `${entry.timestamp} [${entry.level}] ${entry.event}: ${entry.message}${details ? ` (${details})` : ''}${metadata ? `\n${metadata}` : ''}`
}

function toEntries(events: AnalysisDiagnosticEvent[], liveActivity: AnalysisProgressEvent[]): LogEntry[] {
  const diagnostics = events.map((event, index): LogEntry => ({
    id: `diagnostic-${event.timestamp}-${event.event}-${index}`,
    timestamp: event.timestamp,
    level: event.level,
    event: display(event.event, 'Unspecified event'),
    message: display(event.message, 'No message recorded.'),
    provider: event.provider,
    stage: event.stage,
    taskId: event.taskId,
    durationMs: event.durationMs,
    metadata: event.metadata,
    source: 'diagnostic',
  }))
  const activity = liveActivity.map((event, index): LogEntry => ({
    id: `activity-${event.timestamp}-${event.stage}-${index}`,
    timestamp: event.timestamp,
    level: event.taskState === 'failed' ? 'error' : 'info',
    event: 'analysis.progress',
    message: display(event.message, 'Progress event received.'),
    stage: event.stage,
    taskState: event.taskState,
    source: 'activity',
  }))

  return [...diagnostics, ...activity]
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const timestampDifference = timestampValue(right.entry.timestamp) - timestampValue(left.entry.timestamp)
      return timestampDifference || right.index - left.index
    })
    .map(({ entry }) => entry)
}

function LogEntryItem({ entry }: { entry: LogEntry }) {
  const metadata = metadataText(entry.metadata)
  return <li className="thread-row" data-level={entry.level} data-source={entry.source}>
    <div className="thread-main">
      <div className="thread-head">
        <span className={`state-tag ${levelClass(entry.level)}`}>{entry.level}</span>
        <strong>{entry.event}</strong>
        {entry.source === 'activity' && <span className="thread-source">live activity</span>}
      </div>
      <p>{entry.message}</p>
      <div className="thread-meta">
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
        {entry.provider && <span>provider {entry.provider}</span>}
        {entry.stage && <span>stage {entry.stage}</span>}
        {entry.taskId && <span>task {entry.taskId}</span>}
        {entry.taskState && <span>task {entry.taskState}</span>}
        {entry.durationMs !== undefined && <span>{entry.durationMs}ms</span>}
      </div>
      {metadata && <details>
        <summary>Metadata</summary>
        <pre>{metadata}</pre>
      </details>}
    </div>
  </li>
}

export default function LoggingView({ events, liveActivity, running, providerLabel, onClose }: LoggingViewProps) {
  const [level, setLevel] = useState<LevelFilter>('all')
  const [search, setSearch] = useState('')
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const entries = useMemo(() => toEntries(events, liveActivity), [events, liveActivity])
  const filteredEntries = useMemo(() => {
    const query = search.trim().toLowerCase()
    return entries.filter((entry) => {
      const matchesLevel = level === 'all' || entry.level === level
      return matchesLevel && (!query || entrySearchText(entry).includes(query))
    })
  }, [entries, level, search])
  const errors = entries.filter((entry) => entry.level === 'error').length
  const warnings = entries.filter((entry) => entry.level === 'warn').length
  const copyVisibleLogs = useCallback(async () => {
    if (filteredEntries.length === 0) {
      setCopyMessage('No visible logs to copy.')
      return
    }
    try {
      const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard
        ?? (typeof window !== 'undefined' ? window.navigator.clipboard : undefined)
      if (!clipboard?.writeText) throw new Error('Clipboard unavailable')
      await clipboard.writeText(filteredEntries.map(copyLine).join('\n'))
      setCopyMessage(`Copied ${filteredEntries.length} visible ${filteredEntries.length === 1 ? 'event' : 'events'}.`)
    } catch {
      setCopyMessage('Unable to copy logs. Check clipboard permissions and try again.')
    }
  }, [filteredEntries])

  return <section className="view-section logging-page" aria-labelledby="logging-view-heading">
    <div className="overview-intro">
      <div className="section-intro">
        <div className="eyebrow">Operational telemetry</div>
        <h3 id="logging-view-heading">Analysis log</h3>
        <p>{running ? `${providerLabel} is running. Events appear here as the local analysis progresses.` : `A readable record of ${providerLabel} analysis operations and validation milestones.`}</p>
      </div>
      {onClose && <button className="secondary-button" type="button" aria-label="Return to pull requests" onClick={onClose}><ArrowLeft size={13} aria-hidden="true" /> Pull requests</button>}
    </div>

    <div className="summary-grid" aria-label="Log summary">
      <div className="metric"><Activity size={16} aria-hidden="true" /><div><strong>{entries.length}</strong><span>Total events</span><small>Diagnostic and live activity</small></div></div>
      <div className="metric"><AlertCircle size={16} aria-hidden="true" /><div><strong>{errors}</strong><span>Errors</span><small>Failed or blocked operations</small></div></div>
      <div className="metric"><TriangleAlert size={16} aria-hidden="true" /><div><strong>{warnings}</strong><span>Warnings</span><small>Needs attention</small></div></div>
      <div className="metric"><Clock3 size={16} aria-hidden="true" /><div><strong>{running ? 'Live' : 'Idle'}</strong><span>Collection</span><small>{providerLabel}</small></div></div>
    </div>

    <section className="agent-activity" aria-labelledby="logging-events-heading">
      <div className="agent-activity-head">
        <div><strong id="logging-events-heading">Events</strong><span>{filteredEntries.length} of {entries.length} visible</span></div>
        <button className="secondary-button" type="button" onClick={() => { void copyVisibleLogs() }} aria-label="Copy visible logs"><Copy size={13} aria-hidden="true" /> Copy visible logs</button>
      </div>
      <div className="flow-toolbar" aria-label="Log controls">
        <label className="search-box">
          <Search size={14} aria-hidden="true" />
          <span className="sr-only">Search logs</span>
          <input type="search" aria-label="Search logs" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search logs" />
        </label>
        <div className="node-filter" role="group" aria-label="Filter log levels">
          {(['all', 'info', 'warn', 'error'] as LevelFilter[]).map((filter) => <button className={`secondary-button ${level === filter ? 'active' : ''}`} type="button" aria-pressed={level === filter} key={filter} onClick={() => setLevel(filter)}>{filter === 'all' ? 'All' : filter[0].toUpperCase() + filter.slice(1)} <span className="filter-count">{filter === 'all' ? entries.length : entries.filter((entry) => entry.level === filter).length}</span></button>)}
        </div>
      </div>
      <div className="agent-activity-log" role="log" aria-label="Analysis log events" aria-live="polite">
        {running && entries.length === 0 && <p role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Waiting for analysis events…</p>}
        {!running && entries.length === 0 && <div className="empty-analysis"><Activity size={20} aria-hidden="true" /><h4>No analysis events</h4><p>Operational events will appear here after an analysis run starts.</p></div>}
        {entries.length > 0 && filteredEntries.length === 0 && <div className="empty-analysis"><Search size={20} aria-hidden="true" /><h4>No matching events</h4><p>Try a different search term or level filter.</p></div>}
        {filteredEntries.length > 0 && <ol className="diagnostics-activity">{filteredEntries.map((entry) => <LogEntryItem key={entry.id} entry={entry} />)}</ol>}
      </div>
      {running && entries.length > 0 && <small>Live events are appended as the provider reports progress. Private model reasoning is never shown.</small>}
      {copyMessage && <p className="diagnostic-export-status" role="status" aria-live="polite">{copyMessage}</p>}
    </section>
  </section>
}

export { LogEntryItem, toEntries }
