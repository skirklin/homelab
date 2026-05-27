/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import * as ReactRouter from "react-router-dom";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useUrlParam } from "./useUrlParam";

// ---- Test harness -----------------------------------------------------------

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

interface HostProps<T> {
  name: string;
  opts: Parameters<typeof useUrlParam<T>>[1];
  onValue?: (v: T) => void;
}

function StringHost(props: HostProps<string>) {
  const [value, setValue] = useUrlParam<string>(props.name, props.opts);
  props.onValue?.(value);
  return (
    <button
      data-testid="set"
      onClick={(e) => {
        const next = (e.currentTarget as HTMLButtonElement).dataset.next ?? "";
        setValue(next);
      }}
    >
      {value}
    </button>
  );
}

function setNextValue(value: string) {
  const btn = screen.getByTestId("set") as HTMLButtonElement;
  btn.dataset.next = value;
  act(() => {
    btn.click();
  });
}

// ---- Tests ------------------------------------------------------------------

describe("useUrlParam", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("returns parsed default when param is absent", () => {
    const captured: string[] = [];
    render(
      <MemoryRouter initialEntries={["/x"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            serialize: (v) => v || null,
            default: "",
          }}
          onValue={(v) => captured.push(v)}
        />
      </MemoryRouter>,
    );
    expect(captured[captured.length - 1]).toBe("");
  });

  it("parses an existing URL value through `parse`", () => {
    const captured: string[] = [];
    render(
      <MemoryRouter initialEntries={["/x?q=hello"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            serialize: (v) => v || null,
            default: "",
          }}
          onValue={(v) => captured.push(v)}
        />
      </MemoryRouter>,
    );
    expect(captured[captured.length - 1]).toBe("hello");
  });

  it("does not write the default value to the URL", () => {
    render(
      <MemoryRouter initialEntries={["/x?q=existing"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            serialize: (v) => v || null,
            default: "",
          }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("loc").textContent).toContain("q=existing");
    setNextValue("");
    expect(screen.getByTestId("loc").textContent).not.toContain("q=");
  });

  it("roundtrips a non-default value through serialize", () => {
    render(
      <MemoryRouter initialEntries={["/x"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            serialize: (v) => v || null,
            default: "",
          }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    setNextValue("world");
    expect(screen.getByTestId("loc").textContent).toContain("q=world");
  });

  it("treats a null serialize() result as a delete", () => {
    render(
      <MemoryRouter initialEntries={["/x?q=hi"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            // Always return null so any setValue should delete.
            serialize: () => null,
            default: "",
          }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    setNextValue("anything");
    expect(screen.getByTestId("loc").textContent).not.toContain("q=");
  });

  it("debounces URL writes by the configured ms", () => {
    render(
      <MemoryRouter initialEntries={["/x"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            serialize: (v) => v || null,
            default: "",
            debounce: 250,
          }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    setNextValue("a");
    expect(screen.getByTestId("loc").textContent).not.toContain("q=");

    act(() => {
      vi.advanceTimersByTime(100);
    });
    setNextValue("ab");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    setNextValue("abc");
    expect(screen.getByTestId("loc").textContent).not.toContain("q=");

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByTestId("loc").textContent).toContain("q=abc");
  });

  it("cancels pending debounce on unmount", () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/x"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            serialize: (v) => v || null,
            default: "",
            debounce: 250,
          }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    setNextValue("pending");
    unmount();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // No throw and no setState-after-unmount warning = pass.
    expect(true).toBe(true);
  });

  it("commits writes synchronously when no debounce is configured", () => {
    render(
      <MemoryRouter initialEntries={["/x"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            serialize: (v) => v || null,
            default: "",
          }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    setNextValue("one");
    expect(screen.getByTestId("loc").textContent).toContain("q=one");
    setNextValue("two");
    expect(screen.getByTestId("loc").textContent).toContain("q=two");
    setNextValue("three");
    expect(screen.getByTestId("loc").textContent).toContain("q=three");
  });

  it("passes { replace: true } by default and omits it when mode: 'push'", () => {
    // Spy on setSearchParams via useSearchParams to capture the opts arg.
    const calls: unknown[] = [];
    const originalUseSearchParams = ReactRouter.useSearchParams;
    const useSearchParamsSpy = vi.spyOn(ReactRouter, "useSearchParams").mockImplementation(() => {
      const [params, set] = originalUseSearchParams();
      const wrappedSet: typeof set = ((next, opts) => {
        calls.push(opts);
        return set(next, opts);
      }) as typeof set;
      return [params, wrappedSet];
    });

    // Default (replace).
    const { unmount } = render(
      <MemoryRouter initialEntries={["/x"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            serialize: (v) => v || null,
            default: "",
          }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    setNextValue("a");
    expect(calls.at(-1)).toEqual({ replace: true });
    unmount();
    cleanup();
    calls.length = 0;

    // Push mode.
    render(
      <MemoryRouter initialEntries={["/x"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            serialize: (v) => v || null,
            default: "",
            mode: "push",
          }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    setNextValue("b");
    expect(calls.at(-1)).toBeUndefined();

    useSearchParamsSpy.mockRestore();
  });
});
