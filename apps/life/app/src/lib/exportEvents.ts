/**
 * Download the full event log as CSV or JSON. Extracted from LifeDashboard so
 * the Settings modal's Export action can be wired from LifeRoutesInner (which
 * now owns the modal) without depending on the dashboard being mounted.
 */
import type { LogEvent } from "../types";

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Assemble + trigger a download of `entries` (newest first). */
export function exportEvents(entries: LogEvent[], format: "csv" | "json"): void {
  const sortedEntries = [...entries].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
  );
  const date = new Date().toISOString().split("T")[0];

  if (format === "json") {
    const content = JSON.stringify(sortedEntries, null, 2);
    downloadFile(content, `life-tracker-export-${date}.json`, "application/json");
    return;
  }

  const headers = ["timestamp", "subject_id", "source", "entries", "labels"];
  const rows = sortedEntries.map((e) => [
    e.timestamp.toISOString(),
    e.subjectId,
    e.labels?.source ?? "manual",
    JSON.stringify(e.entries),
    JSON.stringify(e.labels ?? {}),
  ]);
  const csv = [
    headers.join(","),
    ...rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")),
  ].join("\n");
  downloadFile(csv, `life-tracker-export-${date}.csv`, "text/csv");
}
