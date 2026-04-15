import { startTransition, useDeferredValue, useMemo, useState } from 'react'
import './App.css'
import { contentItems, type ContentItem, type Format, type Platform } from './data/contentPlan'

type Status = 'Planned' | 'Drafting' | 'Scheduled' | 'Published'
type StatusFilter = 'All' | Status
type PlatformFilter = 'All' | Platform
type FormatFilter = 'All' | Format

type StudioItem = ContentItem & {
  liveStatus: Status
}

type MetricCardProps = {
  label: string
  value: string
  detail: string
}

type FilterChipProps<T extends string> = {
  active: T
  label: T
  onSelect: (value: T) => void
}

type ContentRowProps = {
  item: StudioItem
}

type ScheduleGroupProps = {
  date: string
  items: StudioItem[]
}

const TODAY = '2026-04-15'
const statusOptions: StatusFilter[] = ['All', 'Planned', 'Drafting', 'Scheduled', 'Published']
const platformOptions: PlatformFilter[] = ['All', 'Instagram', 'TikTok']
const formatOptions: FormatFilter[] = ['All', 'Carousel', 'Reel', 'Story', 'TikTok']
const monthLabel = 'April 2026'

const obsidianPaths = [
  {
    label: 'Knowledge index',
    path: '11 Knowledge Base/Indexes/Short Form Content Index.md',
    detail: 'Master index for reusable creator research, hooks, and post analysis.',
  },
  {
    label: 'Post template',
    path: '11 Knowledge Base/Indexes/Short Form Post Template.md',
    detail: 'Shared structure for durable post-level notes that are worth keeping.',
  },
  {
    label: 'Workflow',
    path: '11 Knowledge Base/Posts/Short Form Content Workflow.md',
    detail: 'Rules for what belongs in Obsidian versus what stays operational in Studio.',
  },
  {
    label: 'Legacy system map',
    path: '03 Content Systems/Short-Form Content Tracker.md',
    detail: 'Useful if we need to migrate older notes into the new short-form structure.',
  },
]

const syncFields = [
  'status',
  'platform',
  'format',
  'working_title',
  'canonical_hook',
  'source_note',
  'asset_link',
  'review_required',
  'scheduled_for',
  'published_at',
  'post_url',
  'notes',
] as const

function getLiveStatus(scheduledFor: string): Status {
  if (scheduledFor <= '2026-04-11') {
    return 'Published'
  }

  if (scheduledFor <= '2026-04-14') {
    return 'Scheduled'
  }

  if (scheduledFor <= '2026-04-18') {
    return 'Drafting'
  }

  return 'Planned'
}

function formatDateLabel(date: string) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T12:00:00`))
}

function excerpt(text: string, maxLength = 220) {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength).trim()}...`
}

function MetricCard({ label, value, detail }: MetricCardProps) {
  return (
    <article className="metric-card">
      <p className="eyebrow">{label}</p>
      <p className="metric-value">{value}</p>
      <p className="metric-detail">{detail}</p>
    </article>
  )
}

function FilterChip<T extends string>({ active, label, onSelect }: FilterChipProps<T>) {
  return (
    <button
      className={active === label ? 'filter-chip active' : 'filter-chip'}
      onClick={() => onSelect(label)}
      type="button"
    >
      {label}
    </button>
  )
}

function ContentRow({ item }: ContentRowProps) {
  return (
    <article className="content-row">
      <div className="content-row-header">
        <div className="content-tags">
          <span className={`status-pill status-${item.liveStatus.toLowerCase()}`}>{item.liveStatus}</span>
          <span className="meta-pill">{item.platform}</span>
          <span className="meta-pill">{item.format}</span>
        </div>
        <span className="row-date">{item.scheduledFor}</span>
      </div>

      <div className="content-copy">
        <h3>{item.title}</h3>
        <p className="content-hook">{item.hook}</p>
        <p className="content-notes">{excerpt(item.notes)}</p>
      </div>
    </article>
  )
}

function ScheduleGroup({ date, items }: ScheduleGroupProps) {
  return (
    <section className="schedule-group">
      <header className="schedule-group-header">
        <div>
          <p className="eyebrow">Schedule</p>
          <h2>{formatDateLabel(date)}</h2>
        </div>
        <p className="schedule-count">{items.length} planned touchpoints</p>
      </header>
      <div className="schedule-list">
        {items.map((item) => (
          <ContentRow item={item} key={item.id} />
        ))}
      </div>
    </section>
  )
}

function App() {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All')
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('All')
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('All')

  const deferredQuery = useDeferredValue(query)

  const studioItems = useMemo<StudioItem[]>(
    () =>
      contentItems.map((item) => ({
        ...item,
        liveStatus: getLiveStatus(item.scheduledFor),
      })),
    [],
  )

  const filteredItems = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase()

    return studioItems.filter((item) => {
      if (statusFilter !== 'All' && item.liveStatus !== statusFilter) {
        return false
      }

      if (platformFilter !== 'All' && item.platform !== platformFilter) {
        return false
      }

      if (formatFilter !== 'All' && item.format !== formatFilter) {
        return false
      }

      if (!normalizedQuery) {
        return true
      }

      const haystack = `${item.title} ${item.hook} ${item.notes}`.toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [deferredQuery, formatFilter, platformFilter, statusFilter, studioItems])

  const groupedItems = useMemo(() => {
    const groups = new Map<string, StudioItem[]>()

    for (const item of filteredItems) {
      const existing = groups.get(item.scheduledFor)
      if (existing) {
        existing.push(item)
      } else {
        groups.set(item.scheduledFor, [item])
      }
    }

    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [filteredItems])

  const totals = useMemo(() => {
    const byFormat = {
      Carousel: 0,
      Reel: 0,
      Story: 0,
      TikTok: 0,
    }

    const byStatus = {
      Planned: 0,
      Drafting: 0,
      Scheduled: 0,
      Published: 0,
    }

    for (const item of studioItems) {
      byFormat[item.format] += 1
      byStatus[item.liveStatus] += 1
    }

    return { byFormat, byStatus }
  }, [studioItems])

  const nextUp = useMemo(
    () => studioItems.filter((item) => item.scheduledFor >= TODAY && item.scheduledFor <= '2026-04-21'),
    [studioItems],
  )

  return (
    <main className="studio-shell">
      <section className="command-surface">
        <div className="hero-copy">
          <p className="kicker">Studio dashboard</p>
          <h1>Track every TikTok, Reel, Story, and feed post from one operating surface.</h1>
          <p className="lead">
            April is seeded from the editorial calendar and mapped to the same short-form structure already
            documented in Obsidian. That keeps the site operational and keeps the vault as the durable source of
            research.
          </p>
        </div>

        <div className="hero-meta">
          <div>
            <p className="eyebrow">Source plan</p>
            <p className="hero-label">{monthLabel} editorial calendar</p>
          </div>
          <div>
            <p className="eyebrow">Today</p>
            <p className="hero-label">{formatDateLabel(TODAY)}</p>
          </div>
          <div>
            <p className="eyebrow">Sync target</p>
            <p className="hero-label">studio.bythereeses.com</p>
          </div>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard
          label="Total scheduled"
          value={String(studioItems.length)}
          detail="Every planned April touchpoint across feed, reels, TikTok, and stories."
        />
        <MetricCard
          label="Published so far"
          value={String(totals.byStatus.Published)}
          detail="Seeded by date so the dashboard reads like a live operating board."
        />
        <MetricCard
          label="Next 7 days"
          value={String(nextUp.length)}
          detail="Drafting plus scheduled items from April 15 through April 21, 2026."
        />
        <MetricCard
          label="Channel split"
          value={`${totals.byFormat.TikTok} / ${totals.byFormat.Reel} / ${totals.byFormat.Carousel}`}
          detail="TikTok, Reels, and feed posts stay balanced without hiding Stories."
        />
      </section>

      <section className="workspace-grid">
        <aside className="filters-panel">
          <div className="panel-block">
            <p className="eyebrow">Search</p>
            <label className="search-field">
              <span className="sr-only">Search posts</span>
              <input
                onChange={(event) =>
                  startTransition(() => {
                    setQuery(event.target.value)
                  })
                }
                placeholder="Search hooks, titles, and rationale"
                type="search"
                value={query}
              />
            </label>
          </div>

          <div className="panel-block">
            <p className="eyebrow">Status</p>
            <div className="chip-row">
              {statusOptions.map((option) => (
                <FilterChip active={statusFilter} key={option} label={option} onSelect={setStatusFilter} />
              ))}
            </div>
          </div>

          <div className="panel-block">
            <p className="eyebrow">Platform</p>
            <div className="chip-row">
              {platformOptions.map((option) => (
                <FilterChip active={platformFilter} key={option} label={option} onSelect={setPlatformFilter} />
              ))}
            </div>
          </div>

          <div className="panel-block">
            <p className="eyebrow">Format</p>
            <div className="chip-row">
              {formatOptions.map((option) => (
                <FilterChip active={formatFilter} key={option} label={option} onSelect={setFormatFilter} />
              ))}
            </div>
          </div>

          <div className="panel-block lane-block">
            <div className="lane-header">
              <div>
                <p className="eyebrow">Lane totals</p>
                <h2>Format mix</h2>
              </div>
            </div>
            <ul className="lane-list">
              <li>
                <span>Carousels</span>
                <strong>{totals.byFormat.Carousel}</strong>
              </li>
              <li>
                <span>Reels</span>
                <strong>{totals.byFormat.Reel}</strong>
              </li>
              <li>
                <span>TikToks</span>
                <strong>{totals.byFormat.TikTok}</strong>
              </li>
              <li>
                <span>Stories</span>
                <strong>{totals.byFormat.Story}</strong>
              </li>
            </ul>
          </div>
        </aside>

        <section className="schedule-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Filtered schedule</p>
              <h2>{filteredItems.length} posts in view</h2>
            </div>
            <p className="panel-caption">
              Search and filters stay client-side and lightweight, so this can grow into a larger content inventory
              without changing the interaction model.
            </p>
          </header>

          <div className="schedule-stack">
            {groupedItems.map(([date, items]) => (
              <ScheduleGroup date={date} items={items} key={date} />
            ))}
          </div>
        </section>

        <aside className="sync-panel">
          <div className="panel-block">
            <p className="eyebrow">Obsidian structure</p>
            <h2>Where TikTok lives</h2>
            <div className="path-list">
              {obsidianPaths.map((entry) => (
                <article className="path-card" key={entry.path}>
                  <p>{entry.label}</p>
                  <code>{entry.path}</code>
                  <span>{entry.detail}</span>
                </article>
              ))}
            </div>
          </div>

          <div className="panel-block">
            <p className="eyebrow">Sync contract</p>
            <h2>Fields to preserve</h2>
            <div className="field-grid">
              {syncFields.map((field) => (
                <span className="field-pill" key={field}>
                  {field}
                </span>
              ))}
            </div>
          </div>
        </aside>
      </section>
    </main>
  )
}

export default App
