/** Life tracker domain types */

export interface LifeLog {
  id: string;
  manifest: LifeManifest;
  sampleSchedule: unknown;
}

export interface LifeManifest {
  widgets: WidgetConfig[];
  [key: string]: unknown;
}

export interface WidgetConfig {
  id: string;
  type: string;
  label: string;
  [key: string]: unknown;
}

export interface LifeEntry {
  id: string;
  log: string;
  widgetId: string;
  timestamp: Date;
  createdBy: string;
  data: Record<string, unknown>;
  notes?: string;
}
