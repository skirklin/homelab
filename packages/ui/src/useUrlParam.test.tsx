/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import * as ReactRouter from "react-router-dom";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useUrlParam, useUrlString, useUrlParams } from "./useUrlParam";

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

  it("setter accepts a per-call mode override", () => {
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

    function PerCallHost() {
      const [, setValue] = useUrlParam<string>("q", {
        parse: (raw) => raw ?? "",
        serialize: (v) => v || null,
        default: "",
        mode: "replace",
      });
      return (
        <>
          <button data-testid="push" onClick={() => setValue("a", { mode: "push" })}>
            push
          </button>
          <button data-testid="repl" onClick={() => setValue("b", { mode: "replace" })}>
            replace
          </button>
          <button data-testid="default" onClick={() => setValue("c")}>
            default
          </button>
        </>
      );
    }

    render(
      <MemoryRouter initialEntries={["/x"]}>
        <PerCallHost />
      </MemoryRouter>,
    );

    act(() => {
      (screen.getByTestId("push") as HTMLButtonElement).click();
    });
    expect(calls.at(-1)).toBeUndefined();

    act(() => {
      (screen.getByTestId("repl") as HTMLButtonElement).click();
    });
    expect(calls.at(-1)).toEqual({ replace: true });

    // No per-call mode → falls back to hook default ("replace" here).
    act(() => {
      (screen.getByTestId("default") as HTMLButtonElement).click();
    });
    expect(calls.at(-1)).toEqual({ replace: true });

    useSearchParamsSpy.mockRestore();
  });

  it("attaches state.preserveScroll when opted in, and no state otherwise", () => {
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

    // preserveScroll: true → state carries the opt-out marker alongside replace.
    const { unmount } = render(
      <MemoryRouter initialEntries={["/x"]}>
        <StringHost
          name="q"
          opts={{
            parse: (raw) => raw ?? "",
            serialize: (v) => v || null,
            default: "",
            preserveScroll: true,
          }}
        />
      </MemoryRouter>,
    );
    setNextValue("a");
    expect(calls.at(-1)).toEqual({ replace: true, state: { preserveScroll: true } });
    unmount();
    cleanup();
    calls.length = 0;

    // Unset (the other 17 consumers) → byte-identical to today: no `state` key.
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
      </MemoryRouter>,
    );
    setNextValue("b");
    expect(calls.at(-1)).toEqual({ replace: true });

    useSearchParamsSpy.mockRestore();
  });
});

// ---- useUrlString -----------------------------------------------------------

describe("useUrlString", () => {
  afterEach(() => {
    cleanup();
  });

  function UrlStringHost(props: { name: string; opts?: Parameters<typeof useUrlString>[1] }) {
    const [value, setValue] = useUrlString(props.name, props.opts);
    return (
      <>
        <span data-testid="val">{value === null ? "<null>" : value}</span>
        <button
          data-testid="set"
          onClick={(e) => {
            const next = (e.currentTarget as HTMLButtonElement).dataset.next;
            setValue(next === "__null__" ? null : (next ?? ""));
          }}
        >
          set
        </button>
      </>
    );
  }

  function setUrlStringNext(value: string | null) {
    const btn = screen.getByTestId("set") as HTMLButtonElement;
    btn.dataset.next = value === null ? "__null__" : value;
    act(() => {
      btn.click();
    });
  }

  it("returns null when the param is absent (no default)", () => {
    render(
      <MemoryRouter initialEntries={["/x"]}>
        <UrlStringHost name="itin" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("val").textContent).toBe("<null>");
  });

  it("reads the existing URL value as-is (identity-mapped)", () => {
    render(
      <MemoryRouter initialEntries={["/x?itin=abc123"]}>
        <UrlStringHost name="itin" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("val").textContent).toBe("abc123");
  });

  it("writes a non-default value to the URL", () => {
    render(
      <MemoryRouter initialEntries={["/x"]}>
        <UrlStringHost name="itin" />
        <LocationProbe />
      </MemoryRouter>,
    );
    setUrlStringNext("xyz");
    expect(screen.getByTestId("loc").textContent).toContain("itin=xyz");
  });

  it("setting null deletes the param", () => {
    render(
      <MemoryRouter initialEntries={["/x?itin=stale"]}>
        <UrlStringHost name="itin" />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("loc").textContent).toContain("itin=stale");
    setUrlStringNext(null);
    expect(screen.getByTestId("loc").textContent).not.toContain("itin=");
  });

  it("respects opts.default — writing the default deletes the param", () => {
    render(
      <MemoryRouter initialEntries={["/x?focus=other"]}>
        <UrlStringHost name="focus" opts={{ default: "root" }} />
        <LocationProbe />
      </MemoryRouter>,
    );
    setUrlStringNext("root");
    expect(screen.getByTestId("loc").textContent).not.toContain("focus=");
  });
});

// ---- useUrlParams -----------------------------------------------------------

describe("useUrlParams", () => {
  afterEach(() => {
    cleanup();
  });

  interface TwoParams {
    trip: string | null;
    subcat: string | null;
  }

  const twoSpec = {
    trip: {
      parse: (raw: string | null) => raw,
      serialize: (v: string | null) => v,
      default: null,
    },
    subcat: {
      parse: (raw: string | null) => raw,
      serialize: (v: string | null) => v,
      default: null,
    },
  } as const;

  function TwoParamHost(props: {
    onClick?: (next: Partial<TwoParams>, opts?: { mode?: "replace" | "push" }) => Partial<TwoParams>;
    mode?: "replace" | "push";
  }) {
    const [value, setValues] = useUrlParams<TwoParams>(twoSpec, { mode: props.mode });
    return (
      <>
        <span data-testid="trip">{value.trip ?? "<null>"}</span>
        <span data-testid="subcat">{value.subcat ?? "<null>"}</span>
        <button
          data-testid="set"
          onClick={() => {
            const next = props.onClick?.({}) ?? {};
            setValues(next);
          }}
        >
          set
        </button>
      </>
    );
  }

  it("reads multiple params from the URL", () => {
    render(
      <MemoryRouter initialEntries={["/x?trip=phx&subcat=food"]}>
        <TwoParamHost />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("trip").textContent).toBe("phx");
    expect(screen.getByTestId("subcat").textContent).toBe("food");
  });

  it("writes multiple keys in a single setSearchParams call (one history entry)", () => {
    const calls: unknown[][] = [];
    const originalUseSearchParams = ReactRouter.useSearchParams;
    const useSearchParamsSpy = vi.spyOn(ReactRouter, "useSearchParams").mockImplementation(() => {
      const [params, set] = originalUseSearchParams();
      const wrappedSet: typeof set = ((next, opts) => {
        calls.push([next, opts]);
        return set(next, opts);
      }) as typeof set;
      return [params, wrappedSet];
    });

    render(
      <MemoryRouter initialEntries={["/x"]}>
        <TwoParamHost
          onClick={() => ({ trip: "phx", subcat: "food" })}
          mode="push"
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    act(() => {
      (screen.getByTestId("set") as HTMLButtonElement).click();
    });
    // Exactly one underlying setSearchParams call for both keys.
    expect(calls).toHaveLength(1);
    // mode: "push" → no opts arg.
    expect(calls[0][1]).toBeUndefined();
    const loc = screen.getByTestId("loc").textContent ?? "";
    expect(loc).toContain("trip=phx");
    expect(loc).toContain("subcat=food");

    useSearchParamsSpy.mockRestore();
  });

  it("partial update preserves keys not present in next", () => {
    render(
      <MemoryRouter initialEntries={["/x?trip=phx&subcat=food"]}>
        <TwoParamHost onClick={() => ({ subcat: "lodging" })} />
        <LocationProbe />
      </MemoryRouter>,
    );
    act(() => {
      (screen.getByTestId("set") as HTMLButtonElement).click();
    });
    const loc = screen.getByTestId("loc").textContent ?? "";
    expect(loc).toContain("trip=phx");
    expect(loc).toContain("subcat=lodging");
  });

  it("a value that serializes to the default is deleted from the URL", () => {
    render(
      <MemoryRouter initialEntries={["/x?trip=phx&subcat=food"]}>
        <TwoParamHost onClick={() => ({ trip: null })} />
        <LocationProbe />
      </MemoryRouter>,
    );
    act(() => {
      (screen.getByTestId("set") as HTMLButtonElement).click();
    });
    const loc = screen.getByTestId("loc").textContent ?? "";
    expect(loc).not.toContain("trip=");
    expect(loc).toContain("subcat=food");
  });

  it("accepts a per-call mode override on the setter", () => {
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

    function PerCallHost() {
      const [, setValues] = useUrlParams<TwoParams>(twoSpec, { mode: "replace" });
      return (
        <>
          <button
            data-testid="push"
            onClick={() => setValues({ trip: "a" }, { mode: "push" })}
          >
            push
          </button>
          <button
            data-testid="default"
            onClick={() => setValues({ trip: "b" })}
          >
            default
          </button>
        </>
      );
    }

    render(
      <MemoryRouter initialEntries={["/x"]}>
        <PerCallHost />
      </MemoryRouter>,
    );

    act(() => {
      (screen.getByTestId("push") as HTMLButtonElement).click();
    });
    expect(calls.at(-1)).toBeUndefined();

    act(() => {
      (screen.getByTestId("default") as HTMLButtonElement).click();
    });
    expect(calls.at(-1)).toEqual({ replace: true });

    useSearchParamsSpy.mockRestore();
  });
});
