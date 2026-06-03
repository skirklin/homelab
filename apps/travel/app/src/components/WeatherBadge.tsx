import styled from "styled-components";
import { weatherCodeToCondition } from "./weatherCondition";
import type { WeatherDay } from "../hooks/useTripWeather";

const Badge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  font-weight: 500;
  color: #595959;
  white-space: nowrap;
  flex-shrink: 0;
`;

function tempStr(v: number | null | undefined): string {
  return v == null ? "—" : `${v}°`;
}

/**
 * Compact inline weather: condition emoji + Hi°/Lo°, e.g. `🌧️ 64°/49°`.
 * Tolerant of null temps and a null/unknown weather code (no emoji).
 */
export function WeatherBadge({ day, title }: { day: WeatherDay; title?: string }) {
  const { emoji, label } = weatherCodeToCondition(day.weatherCode ?? null);
  return (
    <Badge title={title ?? label ?? undefined}>
      {emoji && <span>{emoji}</span>}
      <span>
        {tempStr(day.tempMaxF)}/<span style={{ color: "#8c8c8c" }}>{tempStr(day.tempMinF)}</span>
      </span>
    </Badge>
  );
}
