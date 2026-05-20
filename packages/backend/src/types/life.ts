/** Life tracker domain types */

export interface LifeLog {
  id: string;
  sampleSchedule: unknown;
  created: string;
  updated: string;
}

export interface LifeEntry {
  id: string;
  log: string;
  widgetId: string;
  timestamp: Date;
  createdBy: string;
  data: Record<string, unknown>;
  notes?: string;
  created: string;
  updated: string;
}
