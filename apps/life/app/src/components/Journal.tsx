import { useMemo, useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Input, Empty, Button } from "antd";
import {
  SunOutlined,
  MoonOutlined,
  CalendarOutlined,
  SearchOutlined,
  LineChartOutlined,
  BookOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import {
  AppHeader,
  PageContainer,
  Section,
  SectionTitle,
  useUrlParam,
  useAuth,
} from "@kirkl/shared";
import { dayKey, normalizeSessionRuns, DEFAULT_VIEW_TRACKABLES } from "@homelab/backend";
import type { LifeManifestTrackable, SessionView } from "@homelab/backend";
import { useLifeContext } from "../life-context";
import { useSettingsMenu } from "../settings-menu";
import { useLogEvent } from "../lib/useLogEvent";
import { useTrackables } from "../lib/trackables";
import { useViews } from "../lib/views";
import { userTz } from "../lib/useUserTz";
import type { LogEvent } from "../types";
import { findTextEntry, findNumberEntry } from "../lib/format";
import { eventsForDay, labelFor } from "../lib/shapes";
import { toJournalRun, type JournalRun } from "../lib/journalRuns";
import { parseYmdParam } from "../lib/useSelectedDate";
import { EntriesList } from "./EntriesList";
import { EventsEditModal } from "./EventsEditModal";

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const FilterRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-bottom: var(--space-sm);
`;

const Chip = styled.button<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: var(--font-size-sm);
  border-radius: 999px;
  border: 1px solid ${(p) => (p.$active ? "var(--color-primary)" : "var(--color-border)")};
  background: ${(p) => (p.$active ? "var(--color-primary)" : "var(--color-bg)")};
  color: ${(p) => (p.$active ? "white" : "var(--color-text)")};
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;

  &:hover {
    border-color: var(--color-primary);
  }
`;

const SearchWrap = styled.div`
  margin-bottom: var(--space-md);
`;

const ComposeWrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
`;

const ComposeActions = styled.div`
  display: flex;
  justify-content: flex-end;
`;

const OnThisDayRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  margin-bottom: var(--space-md);
`;

const OnThisDayCard = styled.div`
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);

  .anticon {
    color: var(--color-primary);
    font-size: 16px;
    margin-top: 2px;
    flex-shrink: 0;
  }
`;

const OnThisDayLabel = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: 2px;
`;

const OnThisDayPreview = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
`;

const MeasureGroup = styled.div`
  margin-bottom: var(--space-md);

  &:last-child {
    margin-bottom: 0;
  }
`;

const MeasureLabel = styled.div`
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text);
  margin-bottom: var(--space-xs);
`;

const DateGroup = styled.div`
  margin-bottom: var(--space-lg);
`;

const DateHeader = styled.h3`
  font-size: var(--font-size-base);
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-sm) 0;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;

const EntryCard = styled.article<{ $interactive?: boolean }>`
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin-bottom: var(--space-sm);
  cursor: ${(p) => (p.$interactive ? "pointer" : "default")};

  &:hover {
    border-color: ${(p) => (p.$interactive ? "var(--color-primary)" : "var(--color-border)")};
  }
`;

const EntryHeader = styled.header`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin-bottom: var(--space-sm);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);

  .anticon {
    color: var(--color-primary);
    font-size: 14px;
  }
`;

const EntryKind = styled.span`
  font-weight: 500;
  color: var(--color-text);
`;

const EntryTime = styled.span`
  color: var(--color-text-secondary);
`;

const PromptBlock = styled.div`
  margin-bottom: var(--space-sm);

  &:last-child {
    margin-bottom: 0;
  }
`;

const PromptLabel = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: 2px;
`;

const PromptValue = styled.div`
  font-size: var(--font-size-base);
  color: var(--color-text);
  white-space: pre-wrap;
  line-height: 1.5;
`;

const RatingPill = styled.span`
  display: inline-block;
  padding: 2px 10px;
  background: var(--color-bg-muted);
  color: var(--color-text);
  border-radius: 999px;
  font-size: var(--font-size-sm);
  font-weight: 500;
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FilterKey = "all" | SessionView | "journal";

const FILTER_VALUES: readonly FilterKey[] = ["all", "morning", "evening", "weekly", "journal"] as const;
function parseFilter(raw: string | null): FilterKey {
  return raw && (FILTER_VALUES as readonly string[]).includes(raw) ? (raw as FilterKey) : "all";
}

// The three reflective session views, keyed by view id — the value normalized
// runs carry (`run.view`) and the filter chips select on. Title + icon for the
// chip label and run-card header.
const SESSION_VIEWS: { id: SessionView; title: string }[] = [
  { id: "morning", title: "Morning" },
  { id: "evening", title: "Evening" },
  { id: "weekly", title: "Weekly review" },
];

function titleForView(view: SessionView): string {
  return SESSION_VIEWS.find((v) => v.id === view)?.title ?? view;
}

// "journal" subject_id is reserved for freeform / Journey-backfilled entries
// (post-migration). The legacy `freeform_journal` id is matched too so old
// rows surface in the filter without needing a data migration.
const JOURNAL_SUBJECTS = new Set(["journal", "freeform_journal"]);

function iconForView(view: SessionView) {
  if (view === "morning") return <SunOutlined />;
  if (view === "evening") return <MoonOutlined />;
  return <CalendarOutlined />;
}

/** First non-empty text entry on the event, for the on-this-day preview. */
function firstTextOf(entry: LogEvent): string | undefined {
  for (const e of entry.entries) {
    if (e.type === "text" && e.value.trim().length > 0) return e.value;
  }
  return undefined;
}

function formatDateHeader(d: Date, tz: string): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dKey = dayKey(d, tz);
  if (dKey === dayKey(today, tz)) return "Today";
  if (dKey === dayKey(yesterday, tz)) return "Yesterday";
  return dayjs(d).format("MMM D, YYYY");
}

function formatTime(d: Date): string {
  return dayjs(d).format("h:mm A");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Events that are part of a session run — a per-item run child carrying
 * labels.view + labels.view_run. These are rendered as run cards (via
 * normalizeSessionRuns), not as individual journal/measurement rows.
 */
function isRunEvent(entry: LogEvent): boolean {
  return Boolean(entry.labels?.view && entry.labels?.view_run);
}

export function Journal() {
  const navigate = useNavigate();
  const { state } = useLifeContext();
  const { menuItems: settingsMenuItems } = useSettingsMenu();
  const trackables = useTrackables();
  const tz = userTz();
  // Single-event edit modal: tapping a freeform journal entry opens it for
  // edit/delete. Session entries are composite prompt entries, not single-shape
  // events, so they stay non-interactive.
  const [editing, setEditing] = useState<LogEvent | null>(null);
  // Entries subscription is mounted once in LifeRoutesInner so every route
  // inherits today's events from a single feed.

  // Freeform compose box. Writes a `subject_id: "journal"` event with a single
  // `body` text entry — the renderer below reads exactly that name. useLogEvent
  // gives us the Undo toast + error handling for free.
  const { user } = useAuth();
  const logEvent = useLogEvent();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const saveJournal = useCallback(async () => {
    const body = draft.trim();
    if (!body || !user?.uid || !state.log?.id) return;
    setSaving(true);
    const id = await logEvent({
      logId: state.log.id,
      userId: user.uid,
      subjectId: "journal",
      entries: [{ name: "body", type: "text", value: body }],
      label: "journal entry",
      labels: { source: "manual" },
    });
    setSaving(false);
    if (id) setDraft("");
  }, [draft, user?.uid, state.log?.id, logEvent]);

  // Filter chips + search live in the URL so a refresh or shared link
  // (`/journal?filter=morning&q=foo`) round-trips. Defaults aren't written.
  const [filter, setFilter] = useUrlParam<FilterKey>("filter", {
    parse: parseFilter,
    serialize: (v) => (v === "all" ? null : v),
    default: "all",
  });

  // Search: instant local state for typing feedback; URL lags by 250ms.
  const [urlSearch, setUrlSearch] = useUrlParam<string>("q", {
    parse: (raw) => raw ?? "",
    serialize: (v) => v || null,
    default: "",
    debounce: 250,
  });
  const [search, setSearchLocal] = useState(urlSearch);
  const setSearch = useCallback(
    (next: string) => {
      setSearchLocal(next);
      setUrlSearch(next);
    },
    [setUrlSearch],
  );

  // Views + the unified vocab map (user trackables ∪ DEFAULT_VIEW_TRACKABLES,
  // defaults applied LAST so they win on an id collision — same precedence as
  // ViewRunner) drive run rendering (item order + prompt text).
  const views = useViews();
  const vocab = useMemo<Map<string, LifeManifestTrackable>>(() => {
    const m = new Map<string, LifeManifestTrackable>();
    for (const t of trackables) m.set(t.id, t);
    for (const t of DEFAULT_VIEW_TRACKABLES) m.set(t.id, t);
    return m;
  }, [trackables]);

  // The journal stream is a union of session RUNS (dual-shape: fat events OR
  // per-item children, collapsed by normalizeSessionRuns) and freeform journal
  // events. Each carries a timestamp + searchable text so filter/search/group
  // operate uniformly. Newest first.
  type JournalItem =
    | { kind: "run"; id: string; timestamp: Date; view: SessionView; run: JournalRun; text: string }
    | { kind: "journal"; id: string; timestamp: Date; event: LogEvent; text: string };

  const items = useMemo<JournalItem[]>(() => {
    const all = Array.from(state.entries.values());
    const out: JournalItem[] = [];

    // Runs (both shapes) → JournalRun items.
    for (const run of normalizeSessionRuns(all)) {
      const jr = toJournalRun(run, views, vocab);
      const text = jr.blocks
        .filter((b) => b.kind === "text" && b.text)
        .map((b) => b.text as string)
        .join(" ")
        .toLowerCase();
      out.push({ kind: "run", id: jr.id, timestamp: jr.timestamp, view: jr.view, run: jr, text });
    }

    // Freeform journal events (NOT run children, NOT fat sessions).
    for (const e of all) {
      if (!JOURNAL_SUBJECTS.has(e.subjectId)) continue;
      const text = e.entries
        .filter((en) => en.type === "text")
        .map((en) => (en as { value: string }).value)
        .join(" ")
        .toLowerCase();
      out.push({ kind: "journal", id: e.id, timestamp: e.timestamp, event: e, text });
    }

    return out.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }, [state.entries, views, vocab]);

  // Filter + search applied for the main list.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (filter !== "all") {
        if (filter === "journal") {
          if (it.kind !== "journal") return false;
        } else {
          // filter is a session view id; runs carry the same `view`.
          if (it.kind !== "run" || it.view !== filter) return false;
        }
      }
      if (!q) return true;
      return it.text.includes(q);
    });
  }, [items, filter, search]);

  // Group filtered items by user-tz date.
  const grouped = useMemo(() => {
    const groups: { key: string; date: Date; items: JournalItem[] }[] = [];
    let current: { key: string; date: Date; items: JournalItem[] } | null = null;
    for (const it of filtered) {
      const k = dayKey(it.timestamp, tz);
      if (!current || current.key !== k) {
        current = { key: k, date: it.timestamp, items: [] };
        groups.push(current);
      }
      current.items.push(it);
    }
    return groups;
  }, [filtered, tz]);

  // On-this-day: items from exactly 1 week / 1 month / 6 months / 1 year ago.
  const onThisDay = useMemo(() => {
    const today = new Date();

    const offsets: { label: string; date: Date }[] = [
      { label: "1 week ago", date: dayjs(today).subtract(1, "week").toDate() },
      { label: "1 month ago", date: dayjs(today).subtract(1, "month").toDate() },
      { label: "6 months ago", date: dayjs(today).subtract(6, "month").toDate() },
      { label: "1 year ago", date: dayjs(today).subtract(1, "year").toDate() },
    ];

    const result: { label: string; item: JournalItem }[] = [];
    for (const o of offsets) {
      const k = dayKey(o.date, tz);
      // First (chronologically earliest) item for that day, so morning comes first.
      const match = items
        .filter((it) => dayKey(it.timestamp, tz) === k)
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
      if (match) {
        result.push({ label: o.label, item: match });
      }
    }
    return result;
  }, [items, tz]);

  // Preserve `?date=YYYY-MM-DD` when crossing between dashboard / journal /
  // insights so the per-day context survives a tab switch. Only `date` is
  // shared — filter/q stay local to Journal.
  const [dateParam] = useUrlParam<string | null>("date", {
    parse: (raw) => raw,
    serialize: (v) => v,
    default: null,
  });
  const dateQuerySuffix = dateParam ? `?date=${encodeURIComponent(dateParam)}` : "";

  // "See all in Journal" arrives here with `?date=YYYY-MM-DD`. The journal-shaped
  // filter above intentionally excludes measurement/trackable events, so they'd
  // be invisible. When a day is in context, surface that day's MEASUREMENTS
  // (non-session, non-freeform-journal events) grouped by trackable, newest
  // first, reusing the same editable rows the dashboard uses. Reads the same
  // mirror (state.entries) — no separate fetch.
  // `?date=` is parsed with the SAME tz-aware parser the dashboard day-picker
  // uses (anchors at user-tz noon, validates the round-trip) — NOT a local
  // setHours reimplementation — so the measurement day buckets on the user's tz,
  // consistent with the rest of the app's day math.
  const measureDay = useMemo(() => parseYmdParam(dateParam), [dateParam]);
  const measureGroups = useMemo(() => {
    if (!measureDay) return [];
    // eventsForDay buckets by the user's tz (lo/hi = tz-aware start/end of day),
    // so a near-midnight measurement lands on the same local day the picker shows.
    const dayEvents = eventsForDay(Array.from(state.entries.values()), measureDay, tz).filter(
      // Exclude session runs (fat events AND per-item children) + freeform
      // journal — those render as run/journal cards, not measurement rows.
      (e) => !isRunEvent(e) && !JOURNAL_SUBJECTS.has(e.subjectId),
    );
    const bySubject = new Map<string, LogEvent[]>();
    for (const e of dayEvents) {
      const list = bySubject.get(e.subjectId);
      if (list) list.push(e);
      else bySubject.set(e.subjectId, [e]);
    }
    // First-seen (newest-first) trackable order, since dayEvents is sorted.
    return Array.from(bySubject, ([subjectId, events]) => ({
      subjectId,
      label: labelFor(trackables, subjectId),
      events,
    }));
  }, [measureDay, state.entries, trackables, tz]);

  // Hide the Insights link when Coach is disabled — its route redirects to "/"
  // anyway, but offering a dead link is bad UX.
  const coachEnabled = state.log?.coachEnabled ?? true;
  const menuItems = [
    ...(coachEnabled
      ? [
          {
            key: "insights",
            icon: <LineChartOutlined />,
            label: "Insights",
            onClick: () => navigate(`/insights${dateQuerySuffix}`),
          },
        ]
      : []),
    ...settingsMenuItems,
  ];

  return (
    <>
      <AppHeader
        title="Journal"
        onBack={() => navigate(`/${dateQuerySuffix}`)}
        menuItems={menuItems}
      />
      <PageContainer>
        <Section>
          <SectionTitle>New entry</SectionTitle>
          <ComposeWrap>
            <Input.TextArea
              autoSize={{ minRows: 3, maxRows: 12 }}
              placeholder="Write whatever's on your mind…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void saveJournal();
                }
              }}
            />
            <ComposeActions>
              <Button type="primary" loading={saving} disabled={!draft.trim()} onClick={saveJournal}>
                Save entry
              </Button>
            </ComposeActions>
          </ComposeWrap>
        </Section>

        {onThisDay.length > 0 && (
          <Section>
            <SectionTitle>On this day</SectionTitle>
            <OnThisDayRow>
              {onThisDay.map(({ label, item }) => {
                const isRun = item.kind === "run";
                const title = isRun ? titleForView(item.view) : undefined;
                const firstText = isRun
                  ? item.run.blocks.find((b) => b.kind === "text" && b.text)?.text
                  : firstTextOf(item.event);
                return (
                  <OnThisDayCard key={`${label}-${item.id}`}>
                    {isRun ? iconForView(item.view) : <BookOutlined />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <OnThisDayLabel>
                        {label} · {dayjs(item.timestamp).format("MMM D, YYYY")}
                        {title && ` · ${title}`}
                        {!isRun && ` · Journal`}
                      </OnThisDayLabel>
                      {firstText && (
                        <OnThisDayPreview>{firstText}</OnThisDayPreview>
                      )}
                    </div>
                  </OnThisDayCard>
                );
              })}
            </OnThisDayRow>
          </Section>
        )}

        {measureDay && measureGroups.length > 0 && (
          <Section data-testid="journal-measurements">
            <SectionTitle>
              Measurements · {formatDateHeader(measureDay, tz)}
            </SectionTitle>
            {measureGroups.map((g) => (
              <MeasureGroup key={g.subjectId}>
                <MeasureLabel>{g.label}</MeasureLabel>
                <EntriesList events={g.events} emptyText={null} />
              </MeasureGroup>
            ))}
          </Section>
        )}

        <Section>
          <FilterRow>
            <Chip $active={filter === "all"} onClick={() => setFilter("all")}>
              All
            </Chip>
            {SESSION_VIEWS.map((v) => (
              <Chip
                key={v.id}
                $active={filter === v.id}
                onClick={() => setFilter(v.id)}
              >
                {iconForView(v.id)} {v.title}
              </Chip>
            ))}
            <Chip $active={filter === "journal"} onClick={() => setFilter("journal")}>
              <BookOutlined /> Journal
            </Chip>
          </FilterRow>

          <SearchWrap>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Search your reflections…"
              value={search}
              onChange={(e) => setSearch(e.target.value ?? "")}
            />
          </SearchWrap>

          {grouped.length === 0 ? (
            <Empty
              description={
                search.trim()
                  ? "No entries match that search."
                  : "No entries yet. Start a morning or evening session from the dashboard."
              }
            />
          ) : (
            grouped.map((g) => (
              <DateGroup key={g.key}>
                <DateHeader>{formatDateHeader(g.date, tz)}</DateHeader>
                {g.items.map((it) => {
                  if (it.kind === "run") {
                    // A session run renders each captured per-item value as a
                    // labeled prompt block (via toJournalRun). Non-interactive
                    // (composite, not a single editable event).
                    const title = titleForView(it.view);
                    return (
                      <EntryCard key={it.id}>
                        <EntryHeader>
                          {iconForView(it.view)}
                          <EntryKind>{title}</EntryKind>
                          <span>·</span>
                          <EntryTime>{formatTime(it.timestamp)}</EntryTime>
                        </EntryHeader>
                        {it.run.blocks.map((b) => (
                          <PromptBlock key={b.vocabId}>
                            <PromptLabel>{b.prompt}</PromptLabel>
                            <PromptValue>
                              {b.kind === "rating" ? (
                                <RatingPill>
                                  {b.value} / {b.scale ?? 5}
                                </RatingPill>
                              ) : (
                                b.text
                              )}
                            </PromptValue>
                          </PromptBlock>
                        ))}
                      </EntryCard>
                    );
                  }
                  // Freeform journal: render the `body` text + optional mood pill
                  // + a footer line showing location/weather if present.
                  const entry = it.event;
                  const body = findTextEntry(entry, "body");
                  const mood = findNumberEntry(entry, "mood");
                  const labels = entry.labels ?? {};
                  const footerBits: string[] = [];
                  if (labels.location_address) footerBits.push(labels.location_address);
                  if (labels.weather) footerBits.push(labels.weather);
                  return (
                    <EntryCard
                      key={entry.id}
                      $interactive
                      data-testid="journal-entry-card"
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditing(entry)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setEditing(entry);
                        }
                      }}
                    >
                      <EntryHeader>
                        <BookOutlined />
                        <EntryKind>Journal</EntryKind>
                        <span>·</span>
                        <EntryTime>{formatTime(entry.timestamp)}</EntryTime>
                        {mood && (
                          <>
                            <span>·</span>
                            <RatingPill>{mood.value} / {mood.scale ?? 5}</RatingPill>
                          </>
                        )}
                      </EntryHeader>
                      {body && <PromptValue>{body}</PromptValue>}
                      {footerBits.length > 0 && (
                        <PromptLabel style={{ marginTop: "var(--space-sm)" }}>
                          {footerBits.join(" · ")}
                        </PromptLabel>
                      )}
                    </EntryCard>
                  );
                })}
              </DateGroup>
            ))
          )}
        </Section>
      </PageContainer>
      <EventsEditModal
        events={editing ? [editing] : null}
        trackables={trackables}
        onClose={() => setEditing(null)}
      />
    </>
  );
}
