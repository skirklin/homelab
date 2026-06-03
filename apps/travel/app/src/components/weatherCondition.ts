/**
 * Presentation-only mapping from a WMO weather code to an emoji + label.
 * Pure; no React, no I/O. A null code yields an empty emoji (no icon).
 *
 * WMO code groups (Open-Meteo `weathercode`):
 *   0            clear sky          ☀️
 *   1, 2         mainly/partly clear ⛅
 *   3            overcast           ☁️
 *   45, 48       fog                🌫️
 *   51..67       drizzle + rain     🌧️
 *   71..77, 85, 86  snow            ❄️
 *   80..82       rain showers       🌧️
 *   95..99       thunderstorm       ⛈️
 */
export function weatherCodeToCondition(code: number | null): { emoji: string; label: string } {
  if (code === null) return { emoji: "", label: "" };
  if (code === 0) return { emoji: "☀️", label: "Clear" };
  if (code === 1 || code === 2) return { emoji: "⛅", label: "Partly cloudy" };
  if (code === 3) return { emoji: "☁️", label: "Overcast" };
  if (code === 45 || code === 48) return { emoji: "🌫️", label: "Fog" };
  if (code >= 51 && code <= 67) return { emoji: "🌧️", label: "Rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { emoji: "❄️", label: "Snow" };
  if (code >= 80 && code <= 82) return { emoji: "🌧️", label: "Rain showers" };
  if (code >= 95 && code <= 99) return { emoji: "⛈️", label: "Thunderstorm" };
  return { emoji: "", label: "" };
}
