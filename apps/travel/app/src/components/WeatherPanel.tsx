import { useEffect, useState } from "react";
import { Spin, Empty, Typography, Tag } from "antd";
import { CloudOutlined, SkinOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { getApiBase, getAuthHeaders } from "@kirkl/shared";
import type { Trip } from "../types";

// Mirrors the GET /fn/travel/weather response from services/api/src/routes/travel.ts.
interface DailyForecast {
  date: string;
  tempMaxF: number | null;
  tempMinF: number | null;
  precipMm: number | null;
  precipProbabilityMax: number | null;
  windMphMax: number | null;
  uvIndexMax: number | null;
}

interface WeatherResponse {
  tripId: string;
  destination: string;
  state: "available" | "not_yet" | "past" | "unknown_dates" | "no_location";
  availableFrom?: string;
  location?: { lat: number; lon: number; source: string; timezone: string };
  range?: { start: string; end: string };
  forecast: DailyForecast[];
  packingHints: string[];
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const Table = styled.div`
  display: grid;
  grid-template-columns: auto auto auto auto auto;
  gap: 2px 12px;
  align-items: center;
  font-size: 12px;
`;

const HeadCell = styled.div`
  font-size: 10px;
  font-weight: 600;
  color: #8c8c8c;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding-bottom: 2px;
`;

const Cell = styled.div`
  padding: 3px 0;
  color: #262626;
  white-space: nowrap;
`;

const DateCell = styled(Cell)`
  font-weight: 500;
`;

const HintList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const Hint = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  color: #595959;
`;

const SectionLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: #8c8c8c;
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

const SubtleNote = styled.div`
  font-size: 11px;
  color: #bfbfbf;
`;

// A short, friendly message for each non-available state. The panel always
// renders something — never a crash or an empty hole.
const STATE_MESSAGES: Record<string, string> = {
  past: "This trip is over — no forecast to show.",
  unknown_dates: "Add trip dates to see a weather forecast.",
  no_location: "Couldn't find a location for this trip — geocode an activity or set a recognizable destination.",
};

function formatDay(ymd: string): string {
  // ymd is YYYY-MM-DD from Open-Meteo (destination tz). Render as a calendar
  // day with no tz reduction.
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function tempStr(v: number | null): string {
  return v === null ? "—" : `${v}°`;
}

function rainColor(prob: number | null): string {
  if (prob === null) return "#bfbfbf";
  if (prob >= 50) return "#1677ff";
  if (prob >= 25) return "#69b1ff";
  return "#bfbfbf";
}

interface WeatherPanelProps {
  trip: Trip;
}

export function WeatherPanel({ trip }: WeatherPanelProps) {
  const [data, setData] = useState<WeatherResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${getApiBase()}/travel/weather?tripId=${encodeURIComponent(trip.id)}`, {
      headers: getAuthHeaders(),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Forecast request failed (${res.status})`);
        return res.json() as Promise<WeatherResponse>;
      })
      .then((resp) => {
        if (!cancelled) setData(resp);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load forecast");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trip.id]);

  const header = (
    <HeaderRow>
      <CloudOutlined style={{ color: "#1677ff" }} />
      <Typography.Text strong style={{ fontSize: 13 }}>
        Weather &amp; packing
      </Typography.Text>
    </HeaderRow>
  );

  if (loading) {
    return (
      <Container>
        {header}
        <Spin size="small" style={{ margin: "8px 0" }} />
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        {header}
        <SubtleNote>{error}</SubtleNote>
      </Container>
    );
  }

  if (!data) return null;

  if (data.state === "not_yet") {
    return (
      <Container>
        {header}
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span style={{ fontSize: 12 }}>
              Weather forecast available closer to departure
              {data.availableFrom ? ` (from ${formatDay(data.availableFrom)})` : ""}.
            </span>
          }
          style={{ margin: "8px 0" }}
        />
      </Container>
    );
  }

  if (data.state !== "available") {
    return (
      <Container>
        {header}
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<span style={{ fontSize: 12 }}>{STATE_MESSAGES[data.state] || "No forecast available."}</span>}
          style={{ margin: "8px 0" }}
        />
      </Container>
    );
  }

  if (data.forecast.length === 0) {
    return (
      <Container>
        {header}
        <SubtleNote>No daily forecast returned for this range.</SubtleNote>
      </Container>
    );
  }

  return (
    <Container>
      {header}
      <Table>
        <HeadCell>Day</HeadCell>
        <HeadCell>Hi / Lo</HeadCell>
        <HeadCell>Rain</HeadCell>
        <HeadCell>UV</HeadCell>
        <HeadCell>Wind</HeadCell>
        {data.forecast.map((d) => (
          <Row key={d.date} day={d} />
        ))}
      </Table>

      {data.packingHints.length > 0 && (
        <>
          <SectionLabel style={{ marginTop: 4 }}>Packing hints</SectionLabel>
          <HintList>
            {data.packingHints.map((h, i) => (
              <Hint key={i}>
                <SkinOutlined style={{ color: "#13c2c2", marginTop: 2, flexShrink: 0 }} />
                <span>{h}</span>
              </Hint>
            ))}
          </HintList>
        </>
      )}

      {data.location && (
        <SubtleNote>
          {data.location.timezone} · forecast from Open-Meteo
        </SubtleNote>
      )}
    </Container>
  );
}

function Row({ day }: { day: DailyForecast }) {
  const prob = day.precipProbabilityMax;
  return (
    <>
      <DateCell>{formatDay(day.date)}</DateCell>
      <Cell>
        {tempStr(day.tempMaxF)} / <span style={{ color: "#8c8c8c" }}>{tempStr(day.tempMinF)}</span>
      </Cell>
      <Cell>
        <CloudOutlined style={{ color: rainColor(prob), marginRight: 4 }} />
        {prob === null ? "—" : `${prob}%`}
      </Cell>
      <Cell>
        {day.uvIndexMax === null ? (
          "—"
        ) : (
          <Tag
            color={day.uvIndexMax >= 7 ? "volcano" : day.uvIndexMax >= 3 ? "gold" : "default"}
            style={{ margin: 0, fontSize: 11, lineHeight: "16px", padding: "0 5px" }}
          >
            {day.uvIndexMax.toFixed(1)}
          </Tag>
        )}
      </Cell>
      <Cell style={{ color: "#8c8c8c" }}>
        {day.windMphMax === null ? "—" : `${day.windMphMax} mph`}
      </Cell>
    </>
  );
}
