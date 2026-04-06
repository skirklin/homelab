import { createContext, useContext, useState, type ReactNode } from "react";

export type WidgetSize = "compact" | "normal" | "comfortable";

interface DisplaySettings {
  widgetSize: WidgetSize;
  setWidgetSize: (size: WidgetSize) => void;
}

const STORAGE_KEY = "life-tracker:display-settings";

const DisplaySettingsContext = createContext<DisplaySettings | null>(null);

export function DisplaySettingsProvider({ children }: { children: ReactNode }) {
  const [widgetSize, setWidgetSizeState] = useState<WidgetSize>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        return parsed.widgetSize || "normal";
      } catch {
        return "normal";
      }
    }
    return "normal";
  });

  const setWidgetSize = (size: WidgetSize) => {
    setWidgetSizeState(size);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ widgetSize: size }));
  };

  return (
    <DisplaySettingsContext.Provider value={{ widgetSize, setWidgetSize }}>
      {children}
    </DisplaySettingsContext.Provider>
  );
}

export function useDisplaySettings(): DisplaySettings {
  const context = useContext(DisplaySettingsContext);
  if (!context) {
    // Return defaults if not wrapped in provider
    return {
      widgetSize: "normal",
      setWidgetSize: () => {},
    };
  }
  return context;
}

// Style helpers for widgets
export const widgetStyles = {
  compact: {
    padding: "var(--space-sm)",
    minHeight: "60px",
    fontSize: "var(--font-size-sm)",
    labelSize: "var(--font-size-sm)",
    iconSize: "36px",
    gap: "var(--space-sm)",
    buttonSize: "28px",
    buttonFontSize: "12px",
  },
  normal: {
    padding: "var(--space-md)",
    minHeight: "80px",
    fontSize: "var(--font-size-base)",
    labelSize: "var(--font-size-base)",
    iconSize: "48px",
    gap: "var(--space-md)",
    buttonSize: "36px",
    buttonFontSize: "16px",
  },
  comfortable: {
    padding: "var(--space-lg)",
    minHeight: "100px",
    fontSize: "var(--font-size-lg)",
    labelSize: "var(--font-size-lg)",
    iconSize: "56px",
    gap: "var(--space-lg)",
    buttonSize: "44px",
    buttonFontSize: "18px",
  },
};
