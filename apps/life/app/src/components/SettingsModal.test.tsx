/**
 * SettingsModal: the Export CSV / JSON triggers now live here (relocated out of
 * the top hamburger menu). Asserts the buttons render and fire onExport.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";

const mockUserBackend = {
  listPushSubscriptions: vi.fn().mockResolvedValue([]),
  clearPushSubscriptions: vi.fn(),
};
const mockLifeBackend = {
  setRandomSamplingEnabled: vi.fn(),
  setCoachEnabled: vi.fn(),
  setJournalEnabled: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useUserBackend: () => mockUserBackend,
    useLifeBackend: () => mockLifeBackend,
  };
});

import { SettingsModal } from "./SettingsModal";
import { LifeProvider } from "../life-context";

function renderModal(onExport?: (f: "csv" | "json") => void) {
  return render(
    <AntApp>
      <LifeProvider>
        <SettingsModal
          open
          onClose={() => {}}
          log={{ id: "log1" } as never}
          userId="user123"
          onExport={onExport}
        />
      </LifeProvider>
    </AntApp>,
  );
}

describe("SettingsModal Export section", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the Export section with CSV + JSON buttons", () => {
    renderModal(vi.fn());
    expect(screen.getByText("Export")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /CSV/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /JSON/ })).toBeInTheDocument();
  });

  it("fires onExport with the chosen format", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    renderModal(onExport);

    await user.click(screen.getByRole("button", { name: /CSV/ }));
    expect(onExport).toHaveBeenCalledWith("csv");

    await user.click(screen.getByRole("button", { name: /JSON/ }));
    expect(onExport).toHaveBeenCalledWith("json");
  });

  it("omits the Export section when no onExport is provided", () => {
    renderModal(undefined);
    expect(screen.queryByText("Export")).not.toBeInTheDocument();
  });
});

describe("SettingsModal Journal section", () => {
  beforeEach(() => vi.clearAllMocks());

  // The AntD Switch is a role="switch" button with no accessible name from the
  // sibling label, so locate it by walking up from the "Enable Journal" label
  // to its SettingRow and querying the switch within that row.
  function journalSwitch(): HTMLElement {
    // "Enable Journal" (SettingLabel div) → wrapping div → SettingRow, which
    // holds the Switch as a sibling of the wrapping div.
    // eslint-disable-next-line testing-library/no-node-access
    const row = screen.getByText("Enable Journal").parentElement!.parentElement!;
    // eslint-disable-next-line testing-library/no-node-access
    const sw = row.querySelector('[role="switch"]');
    if (!sw) throw new Error("Journal switch not found");
    return sw as HTMLElement;
  }

  it("renders the Journal toggle, checked by default (journalEnabled undefined → on)", () => {
    renderModal();
    expect(screen.getByText("Enable Journal")).toBeInTheDocument();
    // Switch reflects `journalEnabled ?? true` — the log here has no flag → on.
    expect(journalSwitch()).toBeChecked();
  });

  it("calls setJournalEnabled(false) when toggled off", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(journalSwitch());
    expect(mockLifeBackend.setJournalEnabled).toHaveBeenCalledWith("log1", false);
  });
});
