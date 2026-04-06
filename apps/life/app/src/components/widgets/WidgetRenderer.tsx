import type { Widget, LogEntry, EntryMigration } from "../../types";
import { useDisplaySettings, type WidgetSize } from "../../display-settings";
import { CounterWidget } from "./CounterWidget";
import { CounterGroupWidget } from "./CounterGroupWidget";
import { NumberWidget } from "./NumberWidget";
import { RatingWidget } from "./RatingWidget";
import { TextWidget } from "./TextWidget";
import { CheckboxWidget } from "./CheckboxWidget";
import { ComboWidget } from "./ComboWidget";

interface WidgetRendererProps {
  widget: Widget;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
  migrations?: EntryMigration[];
}

export type { WidgetSize };

export function WidgetRenderer({ widget, entries, userId, logId, timestamp, migrations }: WidgetRendererProps) {
  const { widgetSize } = useDisplaySettings();

  // Get IDs of widgets that migrate into this combo widget
  const migratedFromIds = widget.type === "combo"
    ? (migrations ?? []).filter(m => m.to === widget.id).map(m => m.from)
    : [];

  // For counter-group, we need entries for all counter IDs in the group
  // For combo, also include entries from migrated widget IDs
  const widgetEntries = widget.type === "counter-group"
    ? entries.filter(e => widget.counters.some(c => c.id === e.subjectId))
    : widget.type === "combo"
    ? entries.filter(e => e.subjectId === widget.id || migratedFromIds.includes(e.subjectId))
    : entries.filter(e => e.subjectId === widget.id);

  const commonProps = {
    entries: widgetEntries,
    userId,
    logId,
    timestamp,
    size: widgetSize,
  };

  switch (widget.type) {
    case "counter":
      return <CounterWidget widget={widget} {...commonProps} />;
    case "counter-group":
      return <CounterGroupWidget widget={widget} {...commonProps} />;
    case "number":
      return <NumberWidget widget={widget} {...commonProps} />;
    case "rating":
      return <RatingWidget widget={widget} {...commonProps} />;
    case "text":
      return <TextWidget widget={widget} {...commonProps} />;
    case "checkbox":
      return <CheckboxWidget widget={widget} {...commonProps} />;
    case "combo":
      return <ComboWidget widget={widget} {...commonProps} migrations={migrations} />;
    default:
      return null;
  }
}
