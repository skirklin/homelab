/**
 * Shared rendering bits for AI observation cards — used by both the
 * Observations feed and the per-observation ObservationDetail thread, so the
 * period badge looks identical in both places.
 */
import { Tag } from "antd";

const PERIOD_LABELS: Record<string, { label: string; color: string }> = {
  weekly: { label: "Weekly", color: "blue" },
  monthly: { label: "Monthly", color: "purple" },
  adhoc: { label: "On-demand", color: "cyan" },
};

/** Colored Tag for an observation's generation period (falls back to the raw value). */
export function periodTag(period: string) {
  const info = PERIOD_LABELS[period] ?? { label: period, color: "default" };
  return <Tag color={info.color}>{info.label}</Tag>;
}
