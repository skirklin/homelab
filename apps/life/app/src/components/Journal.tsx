import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Input, Empty } from "antd";
import {
  SunOutlined,
  MoonOutlined,
  CalendarOutlined,
  SearchOutlined,
  LineChartOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import {
  AppHeader,
  PageContainer,
  Section,
  SectionTitle,
} from "@kirkl/shared";
import { useLifeContext } from "../life-context";
import { useEntriesSubscription } from "../subscription";
import { SESSIONS, sessionSubjectId, type Session } from "../manifest";
import type { LogEntry } from "../types";

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

type FilterKey = "all" | Session["id"];

function sessionForEntry(entry: LogEntry): Session | undefined {
  return SESSIONS.find((s) => sessionSubjectId(s.id) === entry.subjectId);
}

function iconForSessionId(id: Session["id"]) {
  if (id === "morning") return <SunOutlined />;
  if (id === "evening") return <MoonOutlined />;
  return <CalendarOutlined />;
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

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SESSION_SUBJECT_IDS = new Set(SESSIONS.map((s) => sessionSubjectId(s.id)));

export function Journal() {
  const navigate = useNavigate();
  const { state } = useLifeContext();
  const logId = state.log?.id ?? null;
  useEntriesSubscription(logId);

  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");

  // All session entries, newest first.
  const sessionEntries = useMemo(() => {
    return Array.from(state.entries.values())
      .filter((e) => SESSION_SUBJECT_IDS.has(e.subjectId))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }, [state.entries]);

  // Filter + search applied for the main list.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessionEntries.filter((e) => {
      const session = sessionForEntry(e);
      if (filter !== "all" && session?.id !== filter) return false;
      if (!q) return true;
      // Substring across string values in data.
      for (const v of Object.values(e.data)) {
        if (typeof v === "string" && v.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [sessionEntries, filter, search]);

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
      const match = sessionEntries
        .filter((e) => dateKey(e.timestamp) === k)
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
      if (match) {
        result.push({ label: o.label, entry: match });
      }
    }
    return result;
  }, [sessionEntries]);

  const menuItems = [
    {
      key: "insights",
      icon: <LineChartOutlined />,
      label: "Insights",
      onClick: () => navigate("/insights"),
    },
  ];

  return (
    <>
      <AppHeader
        title="Journal"
        onBack={() => navigate("/")}
        menuItems={menuItems}
      />
      <PageContainer>
        {onThisDay.length > 0 && (
          <Section>
            <SectionTitle>On this day</SectionTitle>
            <OnThisDayRow>
              {onThisDay.map(({ label, entry }) => {
                const session = sessionForEntry(entry);
                const firstText = Object.entries(entry.data).find(
                  ([, v]) => typeof v === "string" && (v as string).trim().length > 0,
                );
                return (
                  <OnThisDayCard key={`${label}-${entry.id}`}>
                    {session ? iconForSessionId(session.id) : <CalendarOutlined />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <OnThisDayLabel>
                        {label} · {dayjs(entry.timestamp).format("MMM D, YYYY")}
                        {session && ` · ${session.title}`}
                      </OnThisDayLabel>
                      {firstText && (
                        <OnThisDayPreview>{firstText[1] as string}</OnThisDayPreview>
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
          </FilterRow>

          <SearchWrap>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Search your reflections…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </SearchWrap>

          {grouped.length === 0 ? (
            <Empty
              description={
                search.trim()
                  ? "No entries match that search."
                  : "No session entries yet. Start a morning or evening session from the dashboard."
              }
            />
          ) : (
            grouped.map((g) => (
              <DateGroup key={g.key}>
                <DateHeader>{formatDateHeader(g.date)}</DateHeader>
                {g.entries.map((entry) => {
                  const session = sessionForEntry(entry);
                  if (!session) return null;
                  return (
                    <EntryCard key={entry.id}>
                      <EntryHeader>
                        {iconForSessionId(session.id)}
                        <EntryKind>{session.title}</EntryKind>
                        <span>·</span>
                        <EntryTime>{formatTime(entry.timestamp)}</EntryTime>
                      </EntryHeader>
                      {session.prompts.map((p) => {
                        const val = entry.data[p.id];
                        if (val === undefined || val === null || val === "") {
                          return null;
                        }
                        return (
                          <PromptBlock key={p.id}>
                            <PromptLabel>{p.label}</PromptLabel>
                            {p.type === "rating" && typeof val === "number" ? (
                              <PromptValue>
                                <RatingPill>
                                  {val} / {p.max ?? 5}
                                </RatingPill>
                              </PromptValue>
                            ) : (
                              <PromptValue>{renderValue(val)}</PromptValue>
                            )}
                          </PromptBlock>
                        );
                      })}
                    </EntryCard>
                  );
                })}
              </DateGroup>
            ))
          )}
        </Section>
      </PageContainer>
    </>
  );
}
