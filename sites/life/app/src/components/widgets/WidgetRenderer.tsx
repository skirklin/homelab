import type { Widget, LogEntry } from "../../types";
import { CounterWidget } from "./CounterWidget";
import { NumberWidget } from "./NumberWidget";
import { RatingWidget } from "./RatingWidget";
import { TextWidget } from "./TextWidget";
import { ComboWidget } from "./ComboWidget";

interface WidgetRendererProps {
  widget: Widget;
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  timestamp?: Date;
}

export function WidgetRenderer({ widget, entries, userId, logId, timestamp }: WidgetRendererProps) {
  const widgetEntries = entries.filter(e => e.subjectId === widget.id);

  const commonProps = {
    entries: widgetEntries,
    userId,
    logId,
    timestamp,
  };

  switch (widget.type) {
    case "counter":
      return <CounterWidget widget={widget} {...commonProps} />;
    case "number":
      return <NumberWidget widget={widget} {...commonProps} />;
    case "rating":
      return <RatingWidget widget={widget} {...commonProps} />;
    case "text":
      return <TextWidget widget={widget} {...commonProps} />;
    case "combo":
      return <ComboWidget widget={widget} {...commonProps} />;
    default:
      return null;
  }
}
