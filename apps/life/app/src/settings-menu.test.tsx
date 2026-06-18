/**
 * buildSettingsMenuItems — the shared Settings/Sign Out fragment. Sign Out (and
 * its divider) is dropped when embedded in the host shell, exactly as the old
 * LifeDashboard menu did.
 */
import { describe, it, expect, vi } from "vitest";
import { buildSettingsMenuItems } from "./settings-menu";

function keysOf(items: ReturnType<typeof buildSettingsMenuItems>): (string | undefined)[] {
  return items.map((i) => (i && "key" in i ? (i.key as string) : undefined));
}

describe("buildSettingsMenuItems", () => {
  it("standalone (not embedded): Settings + divider + Sign Out", () => {
    const items = buildSettingsMenuItems({
      embedded: false,
      onOpenSettings: vi.fn(),
      onSignOut: vi.fn(),
    });
    expect(keysOf(items)).toEqual(["settings", undefined, "logout"]);
    expect(items.some((i) => i && "type" in i && i.type === "divider")).toBe(true);
  });

  it("embedded: Settings only, no Sign Out / divider", () => {
    const items = buildSettingsMenuItems({
      embedded: true,
      onOpenSettings: vi.fn(),
      onSignOut: vi.fn(),
    });
    expect(keysOf(items)).toEqual(["settings"]);
    expect(items.some((i) => i && "key" in i && i.key === "logout")).toBe(false);
  });

  it("wires the handlers to the right items", () => {
    const onOpenSettings = vi.fn();
    const onSignOut = vi.fn();
    const items = buildSettingsMenuItems({ embedded: false, onOpenSettings, onSignOut });
    const settings = items.find((i) => i && "key" in i && i.key === "settings");
    const logout = items.find((i) => i && "key" in i && i.key === "logout");
    (settings as unknown as { onClick: () => void }).onClick();
    (logout as unknown as { onClick: () => void }).onClick();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
