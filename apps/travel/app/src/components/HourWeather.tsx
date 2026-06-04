import styled from "styled-components";
import { weatherCodeToCondition } from "./weatherCondition";
import type { HourlyForecast } from "../hooks/useDayHourlyWeather";

const Wrap = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  font-weight: 500;
  color: #8c8c8c;
  white-space: nowrap;
`;

/**
 * Compact per-activity weather: condition emoji + temp, e.g. `🌧️ 58°`.
 * Reflects the weather at the activity's hour. Null-tolerant: no temp → skip
 * the number, no/unknown weather code → no emoji. Renders nothing if both are
 * absent (caller should generally guard on a non-null `hour` anyway).
 */
export function HourWeather({ hour, title }: { hour: HourlyForecast; title?: string }) {
  const { emoji, label } = weatherCodeToCondition(hour.weatherCode ?? null);
  const tempStr = hour.tempF == null ? "" : `${hour.tempF}°`;
  if (!emoji && !tempStr) return null;
  return (
    <Wrap title={title ?? label ?? undefined}>
      {emoji && <span>{emoji}</span>}
      {tempStr && <span>{tempStr}</span>}
    </Wrap>
  );
}
