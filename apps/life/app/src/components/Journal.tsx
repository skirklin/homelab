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
import { useLifeContext } from "../life-context";
import { useLogEvent } from "../lib/useLogEvent";
import { SESSIONS, sessionSubjectId, type Session } from "../manifest";
import type { LogEntry } from "../types";
import { findTextEntry, findNumberEntry } from "../lib/format";

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

const EntryCard = styled.article`
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin-bottom: var(--space-sm);
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

type FilterKey = "all" | Session["id"] | "journal";

const FILTER_VALUES: readonly FilterKey[] = ["all", "morning", "evening", "weekly_review", "journal"] as const;
function parseFilter(raw: string | null): FilterKey {
  return raw && (FILTER_VALUES as readonly string[]).includes(raw) ? (raw as FilterKey) : "all";
}

function sessionForEntry(entry: LogEntry): Session | undefined {
  return SESSIONS.find((s) => sessionSubjectId(s.id) === entry.subjectId);
}

// "journal" subject_id is reserved for freeform / Journey-backfilled entries
// (post-migration). The legacy `freeform_journal` id is matched too so old
// rows surface in the filter without needing a data migration.
const JOURNAL_SUBJECTS = new Set(["journal", "freeform_journal"]);

function iconForSessionId(id: Session["id"]) {
  if (id === "morning") return <SunOutlined />;
  if (id === "evening") return <MoonOutlined />;
  return <CalendarOutlined />;
}

/** First non-empty text entry on the event, for the on-this-day preview. */
function firstTextOf(entry: LogEntry): string | undefined {
  for (const e of entry.entries) {
    if (e.type === "text" && e.value.trim().length > 0) return e.value;
  }
  return undefined;
}

function dateKey(d: Date): string {
  // YYYY-MM-DD in local time
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function formatDateHeader(d: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dKey = dateKey(d);
  if (dKey === dateKey(today)) return "Today";
  if (dKey === dateKey(yesterday)) return "Yesterday";
  return dayjs(d).format("MMM D, YYYY");
}

function formatTime(d: Date): string {
  return dayjs(d).format("h:mm A");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SESSION_SUBJECT_IDS = new Set(SESSIONS.map((s) => sessionSubjectId(s.id)));

/**
 * Filterable subjects = sessions + journal. Other trackables stay off the
 * Journal view (they're already on the dashboard).
 */
function isJournalable(entry: LogEntry): boolean {
  return SESSION_SUBJECT_IDS.has(entry.subjectId) || JOURNAL_SUBJECTS.has(entry.subjectId);
}

export function Journal() {
  const navigate = useNavigate();
  const { state } = useLifeContext();
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

  // All journal-shaped entries (sessions + freeform journal), newest first.
  const journalEntries = useMemo(() => {
    return Array.from(state.entries.values())
      .filter(isJournalable)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }, [state.entries]);

  // Filter + search applied for the main list.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return journalEntries.filter((e) => {
      if (filter !== "all") {
        if (filter === "journal") {
          if (!JOURNAL_SUBJECTS.has(e.subjectId)) return false;
        } else {
          const session = sessionForEntry(e);
          if (session?.id !== filter) return false;
        }
      }
      if (!q) return true;
      // Substring across all text entries.
      for (const entry of e.entries) {
        if (entry.type === "text" && entry.value.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [journalEntries, filter, search]);

  // Group filtered entries by local date.
  const grouped = useMemo(() => {
    const groups: { key: string; date: Date; entries: LogEntry[] }[] = [];
    let current: { key: string; date: Date; entries: LogEntry[] } | null = null;
    for (const e of filtered) {
      const k = dateKey(e.timestamp);
      if (!current || current.key !== k) {
        current = { key: k, date: e.timestamp, entries: [] };
        groups.push(current);
      }
      current.entries.push(e);
    }
    return groups;
  }, [filtered]);

  // On-this-day: entries from exactly 1 week / 1 month / 6 months / 1 year ago.
  const onThisDay = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const offsets: { label: string; date: Date }[] = [
      { label: "1 week ago", date: dayjs(today).subtract(1, "week").toDate() },
      { label: "1 month ago", date: dayjs(today).subtract(1, "month").toDate() },
      { label: "6 months ago", date: dayjs(today).subtract(6, "month").toDate() },
      { label: "1 year ago", date: dayjs(today).subtract(1, "year").toDate() },
    ];

    const result: { label: string; entry: LogEntry }[] = [];
    for (const o of offsets) {
      const k = dateKey(o.date);
      // First (chronologically earliest) entry for that day, so morning comes first.
      const match = journalEntries
        .filter((e) => dateKey(e.timestamp) === k)
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
      if (match) {
        result.push({ label: o.label, entry: match });
      }
    }
    return result;
  }, [journalEntries]);

  // Preserve `?date=YYYY-MM-DD` when crossing between dashboard / journal /
  // insights so the per-day context survives a tab switch. Only `date` is
  // shared — filter/q stay local to Journal.
  const [dateParam] = useUrlParam<string | null>("date", {
    parse: (raw) => raw,
    serialize: (v) => v,
    default: null,
  });
  const dateQuerySuffix = dateParam ? `?date=${encodeURIComponent(dateParam)}` : "";

  const menuItems = [
    {
      key: "insights",
      icon: <LineChartOutlined />,
      label: "Insights",
      onClick: () => navigate(`/insights${dateQuerySuffix}`),
    },
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
              {onThisDay.map(({ label, entry }) => {
                const session = sessionForEntry(entry);
                const firstText = firstTextOf(entry);
                const isJournal = JOURNAL_SUBJECTS.has(entry.subjectId);
                return (
                  <OnThisDayCard key={`${label}-${entry.id}`}>
                    {session ? iconForSessionId(session.id) : <BookOutlined />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <OnThisDayLabel>
                        {label} · {dayjs(entry.timestamp).format("MMM D, YYYY")}
                        {session && ` · ${session.title}`}
                        {isJournal && ` · Journal`}
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

        <Section>
          <FilterRow>
            <Chip $active={filter === "all"} onClick={() => setFilter("all")}>
              All
            </Chip>
            {SESSIONS.map((s) => (
              <Chip
                key={s.id}
                $active={filter === s.id}
                onClick={() => setFilter(s.id)}
              >
                {iconForSessionId(s.id)} {s.title}
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
                <DateHeader>{formatDateHeader(g.date)}</DateHeader>
                {g.entries.map((entry) => {
                  const session = sessionForEntry(entry);
                  if (session) {
                    // Session entries render each prompt as a labeled block.
                    return (
                      <EntryCard key={entry.id}>
                        <EntryHeader>
                          {iconForSessionId(session.id)}
                          <EntryKind>{session.title}</EntryKind>
                          <span>·</span>
                          <EntryTime>{formatTime(entry.timestamp)}</EntryTime>
                        </EntryHeader>
                        {session.prompts.map((p) => {
                          if (p.type === "text") {
                            const val = findTextEntry(entry, p.id);
                            if (!val) return null;
                            return (
                              <PromptBlock key={p.id}>
                                <PromptLabel>{p.label}</PromptLabel>
                                <PromptValue>{val}</PromptValue>
                              </PromptBlock>
                            );
                          }
                          if (p.type === "rating") {
                            const num = findNumberEntry(entry, p.id);
                            if (!num) return null;
                            return (
                              <PromptBlock key={p.id}>
                                <PromptLabel>{p.label}</PromptLabel>
                                <PromptValue>
                                  <RatingPill>
                                    {num.value} / {num.scale ?? p.max ?? 5}
                                  </RatingPill>
                                </PromptValue>
                              </PromptBlock>
                            );
                          }
                          // number / checkbox fall through to numeric display.
                          const num = findNumberEntry(entry, p.id);
                          if (!num) return null;
                          return (
                            <PromptBlock key={p.id}>
                              <PromptLabel>{p.label}</PromptLabel>
                              <PromptValue>{num.value}</PromptValue>
                            </PromptBlock>
                          );
                        })}
                      </EntryCard>
                    );
                  }
                  if (JOURNAL_SUBJECTS.has(entry.subjectId)) {
                    // Freeform journal: render the `body` text + optional
                    // mood pill + a footer line showing location/weather if
                    // present.
                    const body = findTextEntry(entry, "body");
                    const mood = findNumberEntry(entry, "mood");
                    const labels = entry.labels ?? {};
                    const footerBits: string[] = [];
                    if (labels.location_address) footerBits.push(labels.location_address);
                    if (labels.weather) footerBits.push(labels.weather);
                    return (
                      <EntryCard key={entry.id}>
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
                  }
                  return null;
                })}
              </DateGroup>
            ))
          )}
        </Section>
      </PageContainer>
    </>
  );
}
