import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Input, Button, Select, Empty, Spin, Segmented, Space } from "antd";
import {
  PlusOutlined,
  SearchOutlined,
  FlagOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { WideContainer } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { ShareLogButton } from "./ShareLogButton";
import {
  STATUS_COLORS,
  STATUS_ORDER,
  isTripActive,
  localYmd,
  type Trip,
  type TripStatus,
} from "../types";

// ==========================================
// Styled
// ==========================================

const PageHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
`;

const PageTitle = styled.h1`
  margin: 0;
  font-size: 20px;
  font-weight: 600;
`;

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
`;

const StatusBar = styled.div`
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 12px;
`;

const StatusChip = styled.button<{ $active?: boolean; $color: string }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 12px;
  border: 1.5px solid ${(p) => (p.$active ? p.$color : "#e8e8e8")};
  background: ${(p) => (p.$active ? p.$color + "15" : "white")};
  color: ${(p) => (p.$active ? p.$color : "#595959")};
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.15s;
  &:hover { border-color: ${(p) => p.$color}; }
`;

const Count = styled.span<{ $color: string }>`
  background: ${(p) => p.$color}20;
  color: ${(p) => p.$color};
  font-size: 10px;
  font-weight: 700;
  padding: 0 5px;
  border-radius: 8px;
`;

// ---- Table view (default, dense) ----

const Table = styled.div`
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  overflow: hidden;
`;

const TableHeader = styled.div`
  display: grid;
  grid-template-columns: 1fr 160px 120px 40px;
  gap: 8px;
  padding: 6px 12px;
  background: #fafafa;
  font-size: 11px;
  font-weight: 600;
  color: #8c8c8c;
  text-transform: uppercase;
  letter-spacing: 0.5px;

  @media (max-width: 640px) {
    grid-template-columns: 1fr 120px 40px;
    & > :nth-child(3) { display: none; }
  }
`;

const Row = styled.div`
  display: grid;
  grid-template-columns: 1fr 160px 120px 40px;
  gap: 8px;
  align-items: center;
  padding: 7px 12px;
  cursor: pointer;
  font-size: 13px;
  border-top: 1px solid #f5f5f5;
  &:hover { background: #fafafa; }

  @media (max-width: 640px) {
    grid-template-columns: 1fr 120px 40px;
    & > :nth-child(3) { display: none; }
  }
`;

const Dest = styled.div`
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 5px;
`;

const Muted = styled.span`
  color: #8c8c8c;
  font-size: 12px;
`;

const SectionLabel = styled.div`
  font-size: 11px;
  font-weight: 700;
  color: #8c8c8c;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  padding: 10px 12px 4px;
  background: #fafafa;
  border-top: 1px solid #f0f0f0;
  &:first-child { border-top: none; }
`;

// ---- Active trip banner ----

const ActiveStrip = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
`;

const ActiveCard = styled.button`
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  border-radius: 10px;
  border: 1px solid #b7eb8f;
  background: linear-gradient(135deg, #f6ffed 0%, #e6f7ff 100%);
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: transform 0.1s ease, box-shadow 0.1s ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(22, 119, 255, 0.12);
  }
`;

const ActivePulse = styled.span`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #52c41a;
  box-shadow: 0 0 0 0 rgba(82, 196, 26, 0.5);
  animation: pulse 2s infinite;

  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(82, 196, 26, 0.5); }
    70% { box-shadow: 0 0 0 8px rgba(82, 196, 26, 0); }
    100% { box-shadow: 0 0 0 0 rgba(82, 196, 26, 0); }
  }
`;

const ActiveLabel = styled.span`
  font-size: 11px;
  font-weight: 700;
  color: #389e0d;
  text-transform: uppercase;
  letter-spacing: 0.8px;
`;

const ActiveBody = styled.div`
  flex: 1;
  min-width: 0;
`;

const ActiveName = styled.div`
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 2px;
`;

const ActiveMeta = styled.div`
  font-size: 12px;
  color: #595959;
`;

const ActiveCta = styled.span`
  color: #1677ff;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
`;

// ---- Year timeline view ----

const TimelineContainer = styled.div`
  margin-top: 4px;
`;

const YearSection = styled.div`
  margin-bottom: 24px;
`;

const YearLabel = styled.div`
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 8px;
  color: #262626;
`;

const MonthRow = styled.div`
  display: grid;
  grid-template-columns: 50px 1fr;
  gap: 8px;
  min-height: 28px;
  align-items: start;
`;

const MonthLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: #8c8c8c;
  text-transform: uppercase;
  padding-top: 4px;
`;

const MonthTrips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`;

const TripPill = styled.div<{ $color: string }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 4px;
  background: ${(p) => p.$color}12;
  border-left: 3px solid ${(p) => p.$color};
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.1s;
  &:hover { background: ${(p) => p.$color}25; }
`;

const PillDates = styled.span`
  color: #8c8c8c;
  font-size: 11px;
  font-weight: 400;
`;

const TwoColumn = styled.div`
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 24px;
  align-items: start;

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
  }
`;

const ColumnTitle = styled.div`
  font-size: 13px;
  font-weight: 700;
  color: #595959;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
`;

const IdeasGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`;

const IdeaChip = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 4px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  cursor: pointer;
  font-size: 12px;
  &:hover { background: #f0f0f0; }
`;

const IdeaRegion = styled.span`
  color: #bfbfbf;
  font-size: 11px;
`;

// ==========================================
// Component
// ==========================================

type ViewMode = "table" | "timeline";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function TripList({ embedded: _embedded = false }: { embedded?: boolean }) {
  const { state } = useTravelContext();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TripStatus | "all">("all");
  const [regionFilter, setRegionFilter] = useState<string>("all");
  const [view, setView] = useState<ViewMode>("table");

  // Trips currently in progress (today falls within their date range). Surfaced
  // as a banner at the top so the in-progress trip isn't buried in the list.
  const activeTrips = useMemo(() => {
    const now = new Date();
    return Array.from(state.trips.values())
      .filter((t) => isTripActive(t, now))
      .sort((a, b) => (a.startDate?.getTime() ?? 0) - (b.startDate?.getTime() ?? 0));
  }, [state.trips]);

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of state.trips.values()) c[t.status] = (c[t.status] || 0) + 1;
    return c;
  }, [state.trips]);

  const regions = useMemo(() => {
    const s = new Set<string>();
    for (const t of state.trips.values()) if (t.region) s.add(t.region);
    return Array.from(s).sort();
  }, [state.trips]);

  const activityCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const a of state.activities.values()) c.set(a.tripId, (c.get(a.tripId) || 0) + 1);
    return c;
  }, [state.activities]);

  const filtered = useMemo(() => {
    let trips = Array.from(state.trips.values());
    if (statusFilter !== "all") trips = trips.filter((t) => t.status === statusFilter);
    if (regionFilter !== "all") trips = trips.filter((t) => t.region === regionFilter);
    if (search) {
      const q = search.toLowerCase();
      trips = trips.filter((t) =>
        t.destination.toLowerCase().includes(q) ||
        t.region.toLowerCase().includes(q) ||
        t.notes.toLowerCase().includes(q)
      );
    }
    return trips;
  }, [state.trips, statusFilter, regionFilter, search]);

  // Sort newest first within each group
  const sortNewestFirst = (trips: Trip[]) =>
    [...trips].sort((a, b) => {
      const aDate = a.startDate?.getTime() ?? a.created.getTime();
      const bDate = b.startDate?.getTime() ?? b.created.getTime();
      return bDate - aDate;
    });

  const grouped = useMemo(() => {
    const g: Record<string, Trip[]> = {};
    for (const s of STATUS_ORDER) {
      const m = filtered.filter((t) => t.status === s);
      if (m.length > 0) g[s] = sortNewestFirst(m);
    }
    return g;
  }, [filtered]);

  // Split into planned (non-Idea) and ideas for two-column layout
  const plannedStatuses = STATUS_ORDER.filter((s) => s !== "Idea");
  const plannedGroups = useMemo(() => {
    const g: Record<string, Trip[]> = {};
    for (const s of plannedStatuses) {
      if (grouped[s]) g[s] = grouped[s];
    }
    return g;
  }, [grouped]);
  const ideas = useMemo(() => grouped["Idea"] || [], [grouped]);

  // Timeline: group by year+month
  const timelineData = useMemo(() => {
    const withDates = filtered.filter((t) => t.startDate);
    withDates.sort((a, b) => (a.startDate!.getTime()) - (b.startDate!.getTime()));

    const years = new Map<number, Map<number, Trip[]>>();
    for (const t of withDates) {
      const y = t.startDate!.getFullYear();
      const m = t.startDate!.getMonth();
      if (!years.has(y)) years.set(y, new Map());
      const months = years.get(y)!;
      if (!months.has(m)) months.set(m, []);
      months.get(m)!.push(t);
    }

    // Also include trips without dates
    const noDates = filtered.filter((t) => !t.startDate);

    return { years, noDates };
  }, [filtered]);

  const fmtShort = (d: Date) => {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  if (state.loading) {
    return <WideContainer><Spin size="large" style={{ display: "block", margin: "40px auto" }} /></WideContainer>;
  }

  return (
    <WideContainer>
      <PageHeader>
        <PageTitle>Trips ({filtered.length})</PageTitle>
        <Space size="small">
          {state.log && <ShareLogButton logId={state.log.id} />}
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => navigate("new")}>
            New Trip
          </Button>
        </Space>
      </PageHeader>

      {activeTrips.length > 0 && (
        <ActiveStrip>
          {activeTrips.map((t) => {
            const totalDays = t.startDate && t.endDate
              ? Math.round((t.endDate.getTime() - t.startDate.getTime()) / 86400000) + 1
              : 0;
            const dayNumber = t.startDate
              ? Math.round((new Date().setHours(0, 0, 0, 0) - new Date(localYmd(t.startDate)).setHours(0, 0, 0, 0)) / 86400000) + 1
              : 0;
            return (
              <ActiveCard key={t.id} onClick={() => navigate(t.id)}>
                <ActivePulse />
                <ActiveBody>
                  <ActiveLabel>Currently traveling</ActiveLabel>
                  <ActiveName>{t.destination}</ActiveName>
                  <ActiveMeta>
                    Day {dayNumber}{totalDays > 0 ? ` of ${totalDays}` : ""}
                    {t.region && ` · ${t.region}`}
                  </ActiveMeta>
                </ActiveBody>
                <ActiveCta>Today's plan →</ActiveCta>
              </ActiveCard>
            );
          })}
        </ActiveStrip>
      )}

      <StatusBar>
        {STATUS_ORDER.map((s) => {
          const c = statusCounts[s] || 0;
          if (c === 0 && statusFilter !== s) return null;
          return (
            <StatusChip key={s} $active={statusFilter === s} $color={STATUS_COLORS[s]}
              onClick={() => setStatusFilter(statusFilter === s ? "all" : s)}>
              {s} <Count $color={STATUS_COLORS[s]}>{c}</Count>
            </StatusChip>
          );
        })}
      </StatusBar>

      <Toolbar>
        <Input placeholder="Search..." prefix={<SearchOutlined />} value={search}
          onChange={(e) => setSearch(e.target.value)} allowClear size="small" style={{ maxWidth: 200 }} />
        {regions.length > 1 && (
          <Select value={regionFilter} onChange={setRegionFilter} size="small" style={{ minWidth: 120 }}
            options={[{ label: "All regions", value: "all" }, ...regions.map((r) => ({ label: r, value: r }))]} />
        )}
        <div style={{ flex: 1 }} />
        <Segmented size="small" value={view} onChange={(v) => setView(v as ViewMode)} options={[
          { value: "table", label: "List" },
          { value: "timeline", label: "Calendar" },
        ]} />
      </Toolbar>

      {filtered.length === 0 ? (
        <Empty description="No trips found" />
      ) : view === "table" ? (
        <TwoColumn>
          <div>
            <Table>
              <TableHeader>
                <div>Destination</div>
                <div>Dates</div>
                <div>Region</div>
                <div>#</div>
              </TableHeader>
              {Object.entries(plannedGroups).map(([status, trips]) => (
                <div key={status}>
                  <SectionLabel>{status} ({trips.length})</SectionLabel>
                  {trips.map((t) => (
                    <Row key={t.id} onClick={() => navigate(t.id)}>
                      <Dest>
                        {t.flaggedForReview && <FlagOutlined style={{ color: "#fa541c", fontSize: 11 }} />}
                        {t.destination}
                      </Dest>
                      <Muted>
                        {t.startDate ? fmtShort(t.startDate) : ""}
                        {t.endDate ? ` – ${fmtShort(t.endDate)}` : ""}
                      </Muted>
                      <Muted>{t.region}</Muted>
                      <Muted>{activityCounts.get(t.id) || 0}</Muted>
                    </Row>
                  ))}
                </div>
              ))}
            </Table>
          </div>
          {ideas.length > 0 && (
            <div>
              <ColumnTitle>Ideas ({ideas.length})</ColumnTitle>
              {(() => {
                // Group ideas by region
                const byRegion = new Map<string, Trip[]>();
                for (const t of ideas) {
                  const r = t.region || "Other";
                  if (!byRegion.has(r)) byRegion.set(r, []);
                  byRegion.get(r)!.push(t);
                }
                return Array.from(byRegion.entries()).map(([region, trips]) => (
                  <div key={region} style={{ marginBottom: 10 }}>
                    <Muted style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                      {region}
                    </Muted>
                    <IdeasGrid style={{ marginTop: 4 }}>
                      {trips.map((t) => (
                        <IdeaChip key={t.id} onClick={() => navigate(t.id)}>
                          {t.destination}
                          {t.startDate && <IdeaRegion>{fmtShort(t.startDate)}</IdeaRegion>}
                        </IdeaChip>
                      ))}
                    </IdeasGrid>
                  </div>
                ));
              })()}
            </div>
          )}
        </TwoColumn>
      ) : (
        <TimelineContainer>
          {Array.from(timelineData.years.entries())
            .sort((a, b) => b[0] - a[0])
            .map(([year, months]) => (
              <YearSection key={year}>
                <YearLabel>{year}</YearLabel>
                {Array.from({ length: 12 }, (_, m) => {
                  const trips = months.get(m);
                  if (!trips) {
                    // Show empty months between first and last trip month
                    const monthNums = Array.from(months.keys());
                    if (m >= Math.min(...monthNums) && m <= Math.max(...monthNums)) {
                      return (
                        <MonthRow key={m}>
                          <MonthLabel>{MONTHS[m]}</MonthLabel>
                          <MonthTrips />
                        </MonthRow>
                      );
                    }
                    return null;
                  }
                  return (
                    <MonthRow key={m}>
                      <MonthLabel>{MONTHS[m]}</MonthLabel>
                      <MonthTrips>
                        {trips.map((t) => (
                          <TripPill key={t.id} $color={STATUS_COLORS[t.status]} onClick={() => navigate(t.id)}>
                            {t.destination}
                            <PillDates>
                              {t.startDate ? fmtShort(t.startDate) : ""}
                              {t.endDate ? `–${fmtShort(t.endDate)}` : ""}
                            </PillDates>
                          </TripPill>
                        ))}
                      </MonthTrips>
                    </MonthRow>
                  );
                })}
              </YearSection>
            ))}
          {timelineData.noDates.length > 0 && (
            <YearSection>
              <YearLabel>No dates</YearLabel>
              <MonthTrips>
                {timelineData.noDates.map((t) => (
                  <TripPill key={t.id} $color={STATUS_COLORS[t.status]} onClick={() => navigate(t.id)}>
                    {t.destination}
                  </TripPill>
                ))}
              </MonthTrips>
            </YearSection>
          )}
        </TimelineContainer>
      )}
    </WideContainer>
  );
}
