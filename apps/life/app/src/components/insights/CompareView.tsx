/**
 * Compare — period-over-period. For the selected trackables, show this
 * week/month vs the previous one, with the absolute value, %Δ, and a ▲▼ trend.
 * A compact table reads cleanly on mobile; ratings compare by mean, magnitudes
 * and counts by sum (the same reduction as the week/month series buckets).
 */
import { useMemo } from "react";
import { Select, Segmented, Empty } from "antd";
import { CaretUpFilled, CaretDownFilled, MinusOutlined } from "@ant-design/icons";
import styled from "styled-components";
import type { DayIndex } from "../../lib/dayIndex";
import { periodCompare, type PeriodComparison } from "../../lib/analysis";
import type { Series } from "./model";
import { trackableArg } from "./model";
import { Controls } from "./shared";

type Period = "week" | "month";

const Table = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
`;

const Row = styled.div`
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
`;

const Label = styled.div`
  font-weight: 500;
`;

const Value = styled.div`
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-primary);
  text-align: right;
`;

const Prev = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  text-align: right;
`;

const Delta = styled.div<{ $dir: "up" | "down" | "flat" }>`
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: flex-end;
  font-size: var(--font-size-sm);
  min-width: 64px;
  color: ${(p) =>
    p.$dir === "up" ? "var(--color-success, #16a34a)" : p.$dir === "down" ? "var(--color-error, #dc2626)" : "var(--color-text-secondary)"};
`;

function DeltaCell({ cmp }: { cmp: PeriodComparison }) {
  const dir = cmp.deltaAbs > 0 ? "up" : cmp.deltaAbs < 0 ? "down" : "flat";
  const icon = dir === "up" ? <CaretUpFilled /> : dir === "down" ? <CaretDownFilled /> : <MinusOutlined />;
  // %Δ is null when the previous period was empty (no baseline to divide by).
  const pct = cmp.deltaPct === null ? "—" : `${cmp.deltaPct > 0 ? "+" : ""}${cmp.deltaPct}%`;
  return (
    <Delta $dir={dir}>
      {icon}
      <span>{pct}</span>
    </Delta>
  );
}

export function CompareView({
  index,
  allSeries,
  tz,
  selectedKeys,
  onSelect,
  period,
  onPeriod,
}: {
  index: DayIndex;
  allSeries: Series[];
  tz: string;
  selectedKeys: string[];
  onSelect: (keys: string[]) => void;
  period: Period;
  onPeriod: (p: Period) => void;
}) {
  const picked = useMemo(
    () => selectedKeys.map((k) => allSeries.find((s) => s.key === k)).filter((s): s is Series => !!s),
    [selectedKeys, allSeries],
  );

  const rows = useMemo(() => {
    const today = new Date();
    return picked.map((s) => ({
      series: s,
      cmp: periodCompare(index, trackableArg(s), s.subjectIds, period, tz, today),
    }));
  }, [picked, index, period, tz]);

  if (allSeries.length === 0) return <Empty description="Nothing to compare yet" />;

  return (
    <div>
      <Controls>
        <Select
          mode="multiple"
          value={selectedKeys}
          onChange={(keys) => onSelect(keys as string[])}
          options={allSeries.map((s) => ({ value: s.key, label: s.label }))}
          maxTagCount="responsive"
          showSearch
          optionFilterProp="label"
          placeholder="Pick trackables to compare"
          style={{ minWidth: 240, flex: 1 }}
        />
        <Segmented<Period>
          value={period}
          onChange={onPeriod}
          options={[{ label: "Week", value: "week" }, { label: "Month", value: "month" }]}
        />
      </Controls>

      {rows.length === 0 ? (
        <Empty description="Pick one or more trackables" />
      ) : (
        <Table>
          {rows.map(({ series, cmp }) => (
            <Row key={series.key}>
              <Label>{series.label}</Label>
              <Value>{cmp.current}</Value>
              <Prev>was {cmp.previous}</Prev>
              <DeltaCell cmp={cmp} />
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}
