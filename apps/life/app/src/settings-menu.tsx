/**
 * Shared "Settings (+ Sign Out)" header menu, made reachable from EVERY
 * bottom-tab route (Log, Today, Journal, Coach). The SettingsModal is mounted
 * ONCE in LifeRoutesInner, which provides this context; each tab screen pulls
 * the shared `menuItems` fragment and appends it to its own AppHeader menu, so
 * the gear is uniform without re-mounting the modal per route.
 *
 * The default value is an inert no-op (empty fragment) so the per-route screens
 * still render when mounted WITHOUT the provider — e.g. in their own unit tests
 * — instead of throwing.
 */
import { createContext, useContext, type ReactNode } from "react";
import { ControlOutlined, LogoutOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";

export interface SettingsMenuValue {
  /**
   * The shared header-menu fragment: a "Settings" item, plus (when not embedded
   * in the host shell) a divider + "Sign Out". Append to a route's own items.
   */
  menuItems: NonNullable<MenuProps["items"]>;
}

/**
 * Build the shared fragment. `embedded` (host shell owns account chrome) drops
 * the Sign Out item + its divider — mirroring the old LifeDashboard behavior.
 */
export function buildSettingsMenuItems(opts: {
  embedded: boolean;
  onOpenSettings: () => void;
  onSignOut: () => void;
}): SettingsMenuValue["menuItems"] {
  return [
    {
      key: "settings",
      icon: <ControlOutlined />,
      label: "Settings",
      onClick: opts.onOpenSettings,
    },
    ...(!opts.embedded
      ? [
          { type: "divider" as const },
          {
            key: "logout",
            icon: <LogoutOutlined />,
            label: "Sign Out",
            onClick: opts.onSignOut,
          },
        ]
      : []),
  ];
}

const SettingsMenuContext = createContext<SettingsMenuValue>({ menuItems: [] });

export function SettingsMenuProvider({
  value,
  children,
}: {
  value: SettingsMenuValue;
  children: ReactNode;
}) {
  return (
    <SettingsMenuContext.Provider value={value}>{children}</SettingsMenuContext.Provider>
  );
}

/** The shared Settings/Sign Out menu fragment for the current route's gear. */
export function useSettingsMenu(): SettingsMenuValue {
  return useContext(SettingsMenuContext);
}
