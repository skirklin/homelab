import { Spin, Empty, Typography } from "antd";
import { SkinOutlined } from "@ant-design/icons";
import styled from "styled-components";
import type { Trip } from "../types";
import { useTripWeather, type UseTripWeather } from "../hooks/useTripWeather";

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

const SubtleNote = styled.div`
  font-size: 11px;
  color: #bfbfbf;
`;

// A short, friendly message for each non-available state. The panel always
// renders something — never a crash or an empty hole.
const STATE_MESSAGES: Record<string, string> = {
  unknown_dates: "Add trip dates to see packing hints.",
  no_location: "Couldn't find a location for this trip — geocode an activity or set a recognizable destination.",
};

function formatDay(ymd: string): string {
  // ymd is YYYY-MM-DD (destination tz from Open-Meteo). Render as a pure
  // calendar day with no local-tz reduction.
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

interface WeatherPanelProps {
  trip: Trip;
  /**
   * Optional shared weather state (from useTripWeather at the parent). When
   * omitted the panel fetches its own — but TripDetail passes it in so the
   * per-day badges and this panel share one request.
   */
  weather?: UseTripWeather;
}

export function WeatherPanel({ trip, weather }: WeatherPanelProps) {
  // Hook is always called (rules-of-hooks); the parent-supplied `weather`
  // wins when present so we don't double-fetch.
  const own = useTripWeather(weather ? undefined : trip.id);
  const { data, loading, error } = weather ?? own;

  const header = (
    <HeaderRow>
      <SkinOutlined style={{ color: "#13c2c2" }} />
      <Typography.Text strong style={{ fontSize: 13 }}>
        Packing
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
              Packing hints available closer to departure
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
          description={<span style={{ fontSize: 12 }}>{STATE_MESSAGES[data.state] || "No packing hints available."}</span>}
          style={{ margin: "8px 0" }}
        />
      </Container>
    );
  }

  // Available but no forward-looking days (e.g. a trip that's wholly in the
  // past, all actuals) → no packing to suggest. Render a graceful note.
  if (data.packingHints.length === 0) {
    return (
      <Container>
        {header}
        <SubtleNote>
          {data.forecast.length > 0 ? "Trip complete — see per-day weather on the itinerary." : "No packing hints for this trip."}
        </SubtleNote>
      </Container>
    );
  }

  return (
    <Container>
      {header}
      <HintList>
        {data.packingHints.map((h, i) => (
          <Hint key={i}>
            <SkinOutlined style={{ color: "#13c2c2", marginTop: 2, flexShrink: 0 }} />
            <span>{h}</span>
          </Hint>
        ))}
      </HintList>

      {data.location && (
        <SubtleNote>
          {data.location.timezone} · forecast from Open-Meteo
        </SubtleNote>
      )}
    </Container>
  );
}
