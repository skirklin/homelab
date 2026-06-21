/**
 * Shared formatting + date-math helpers, hoisted from per-app copies.
 *
 * The currency formatters were each redefined a dozen-plus times in the money
 * app with SUBTLY different output rules (abbreviation thresholds, decimal
 * precision, sign handling). They are deliberately kept as distinct named
 * functions here rather than collapsed into one "smart" formatter: every call
 * site keeps byte-identical displayed output, this is purely a de-duplication.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Raw, unrounded difference in days between two dates: `(a - b) / 1 day`.
 * Callers apply their own `Math.floor` / `Math.round` / `Math.abs` so each
 * preserves its existing rounding behavior.
 */
export function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / MS_PER_DAY;
}

/**
 * Abbreviated dollars, M/K (no B): `$1.23M`, `$45.6K`, `$1.23K`, `$12.34`.
 * Used by the money account/institution/person/grants summaries.
 */
export function fmtDollarAbbrev(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Abbreviated dollars with a billions tier: `$1.23B`, `$1.23M`, …
 * Used by the allocation + investments views where balances reach 9 figures.
 */
export function fmtDollarAbbrevB(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Whole-dollar magnitude, grouped, sign dropped: `$1,234`.
 * (`Math.abs` first, so negatives lose their sign — matches the original.)
 */
export function fmtDollarWhole(v: number): string {
  return `$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/**
 * Whole-dollar, grouped, sign PRESERVED via toLocaleString: `$1,234` / `$-1,234`.
 * Distinct from {@link fmtDollarWhole} which strips the sign with Math.abs.
 */
export function fmtDollarWholeSigned(v: number): string {
  return `$${v.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/**
 * Two-decimal dollars with an explicit `+`/`-` sign: `+$12.34` / `-$12.34`.
 * Used by transaction tables where direction matters.
 */
export function fmtDollarSignedExplicit(v: number): string {
  return `${v < 0 ? "-" : "+"}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Two-decimal dollars, `-` for negatives but NO leading `+`: `$12.34` / `-$12.34`.
 */
export function fmtDollarSignedMinus(v: number): string {
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
