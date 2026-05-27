import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";

/** Per-call override of the URL commit mode. */
export interface UrlParamSetOptions {
  /** Override the hook's default mode for this single call. */
  mode?: "replace" | "push";
}

/**
 * Options for {@link useUrlParam}.
 *
 * @template T - The decoded value type.
 */
export interface UseUrlParamOptions<T> {
  /** Decode the raw query-string value into `T`. Receives `null` when the param is absent. */
  parse: (raw: string | null) => T;
  /** Encode `T` back to a string, or `null` to delete the param. */
  serialize: (value: T) => string | null;
  /** Default value. When the new value `serialize`s to the same string as this default, the param is deleted. */
  default: T;
  /** If set, the URL write is debounced by this many ms. The setter still returns synchronously. */
  debounce?: number;
  /** How the URL update is committed. Defaults to `"replace"` to match the codebase convention. */
  mode?: "replace" | "push";
}

/**
 * Setter returned by {@link useUrlParam}. Optionally accepts a per-call mode override.
 *
 * The 2nd arg is typed as `UrlParamSetOptions | unknown` so the setter remains assignable
 * to permissive event-handler signatures (e.g. antd's `<Select onChange={setter}>` where
 * the 2nd positional arg is the matched option object). At runtime we only honor the arg
 * if it duck-types as `{ mode }`; anything else is ignored. Explicit callers still get
 * autocomplete by passing `{ mode: "push" }`.
 */
export type UrlParamSetter<T> = (value: T, opts?: UrlParamSetOptions | unknown) => void;

function extractSetOptions(raw: unknown): UrlParamSetOptions | undefined {
  if (raw && typeof raw === "object" && "mode" in raw) {
    const mode = (raw as { mode?: unknown }).mode;
    if (mode === "replace" || mode === "push") {
      return { mode };
    }
  }
  return undefined;
}

/**
 * Bind a single URL search param to a typed value.
 *
 * - Reading: `parse(searchParams.get(name))` runs on every render.
 * - Writing: calls `serialize(value)`; if the result equals `serialize(default)` or is `null`,
 *   the param is removed (default-not-written-by-construction).
 * - Mode: `"replace"` (default) uses `setSearchParams(..., { replace: true })`; `"push"` omits the flag.
 *   The setter accepts an optional 2nd argument `{ mode }` that overrides the default for that call.
 * - Debounce: when provided, the setter coalesces writes so the URL only updates `debounce`ms after
 *   the last call. Pending timers are cancelled on the next call and on unmount. The reader is
 *   un-debounced — callers that want instant local feedback should keep a `useState` mirror and
 *   let the URL lag behind.
 */
export function useUrlParam<T>(
  name: string,
  opts: UseUrlParamOptions<T>,
): [T, UrlParamSetter<T>] {
  const [searchParams, setSearchParams] = useSearchParams();
  const { parse, serialize, debounce, mode: defaultMode = "replace" } = opts;

  const value = parse(searchParams.get(name));

  // Stash the "absent" serialization so we know what to compare against to decide
  // whether to write or delete. Recomputed only when `default` identity changes.
  const defaultSerializedRef = useRef<string | null>(serialize(opts.default));
  defaultSerializedRef.current = serialize(opts.default);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always cancel pending timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const commit = useCallback(
    (next: T, mode: "replace" | "push") => {
      const encoded = serialize(next);
      const setOpts = mode === "replace" ? { replace: true } : undefined;
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        if (encoded === null || encoded === defaultSerializedRef.current) {
          params.delete(name);
        } else {
          params.set(name, encoded);
        }
        return params;
      }, setOpts);
    },
    [name, serialize, setSearchParams],
  );

  const setValue = useCallback<UrlParamSetter<T>>(
    (next, callOpts) => {
      const mode = extractSetOptions(callOpts)?.mode ?? defaultMode;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (debounce && debounce > 0) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          commit(next, mode);
        }, debounce);
      } else {
        commit(next, mode);
      }
    },
    [commit, debounce, defaultMode],
  );

  return [value, setValue];
}

/**
 * Options for {@link useUrlString}.
 */
export interface UseUrlStringOptions {
  /** Value returned when the param is absent. Defaults to `null`. */
  default?: string | null;
  /** How the URL update is committed. Defaults to `"replace"`. */
  mode?: "replace" | "push";
  /** Debounce ms; see {@link UseUrlParamOptions.debounce}. */
  debounce?: number;
}

/**
 * Shorthand for identity-mapped string params (the param IS the value — no enum, no parse).
 * Equivalent to `useUrlParam<string | null>(name, { parse: raw => raw, serialize: v => v, default: null })`.
 *
 * Returns `[value, setter]` where `value` is `string | null` (null when absent) and `setter` accepts
 * `null` to delete the param. The setter also accepts a per-call `{ mode }` override like `useUrlParam`.
 */
export function useUrlString(
  name: string,
  opts?: UseUrlStringOptions,
): [string | null, UrlParamSetter<string | null>] {
  const defaultValue = opts?.default ?? null;
  return useUrlParam<string | null>(name, {
    parse: (raw) => raw,
    serialize: (v) => v,
    default: defaultValue,
    mode: opts?.mode,
    debounce: opts?.debounce,
  });
}

/**
 * Per-key spec for {@link useUrlParams}.
 */
export interface UrlParamSpec<V> {
  parse: (raw: string | null) => V;
  serialize: (value: V) => string | null;
  default: V;
}

/**
 * Spec map for {@link useUrlParams}. One entry per param name; the param name is the object key.
 */
export type UrlParamsSpec<T> = { [K in keyof T]: UrlParamSpec<T[K]> };

/**
 * Setter returned by {@link useUrlParams}. Merges `next` into the current state and writes all
 * affected keys in a single `setSearchParams` call (one history entry). See {@link UrlParamSetter}
 * for why the 2nd arg uses the lenient `UrlParamSetOptions | unknown` type.
 */
export type UrlParamsSetter<T> = (next: Partial<T>, opts?: UrlParamSetOptions | unknown) => void;

/**
 * Options for {@link useUrlParams}.
 */
export interface UseUrlParamsOptions {
  /** How the URL update is committed. Defaults to `"replace"`. */
  mode?: "replace" | "push";
}

/**
 * Bind multiple URL search params to a typed object, writing all changes in a single history entry.
 *
 * Use this when a single user action needs to mutate several params atomically (e.g. clearing a
 * drilldown that resets `?trip=` AND `?subcat=`, or a sort UI that writes `?sort=` and `?dir=`).
 * Per-key default-not-written rules apply: a key whose new value matches its default's serialization
 * is deleted from the URL.
 *
 * The setter merges `next` (a partial) into the current state — keys not present in `next` are
 * preserved. Pass `null`-serializing values to clear individual keys.
 */
export function useUrlParams<T extends object>(
  spec: UrlParamsSpec<T>,
  opts?: UseUrlParamsOptions,
): [T, UrlParamsSetter<T>] {
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultMode = opts?.mode ?? "replace";

  // Spec identity may change render-to-render; capture in a ref so the setter
  // doesn't churn its callback identity.
  const specRef = useRef(spec);
  specRef.current = spec;

  // Stable list of keys for the value memo. We re-derive on every render since
  // the spec object identity may not be stable, but the keys typically are.
  const keys = Object.keys(spec) as (keyof T)[];
  const keysSig = keys.join("|");

  const value = useMemo(() => {
    const out = {} as T;
    for (const k of Object.keys(specRef.current) as (keyof T)[]) {
      const s = specRef.current[k];
      out[k] = s.parse(searchParams.get(k as string));
    }
    return out;
    // searchParams identity flips on any URL change; keysSig guards against
    // spec-shape changes. Re-running on every searchParams change is what we
    // want — the value is derived from the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, keysSig]);

  const setValues = useCallback<UrlParamsSetter<T>>(
    (next, callOpts) => {
      const mode = extractSetOptions(callOpts)?.mode ?? defaultMode;
      const setOpts = mode === "replace" ? { replace: true } : undefined;
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        for (const k of Object.keys(next) as (keyof T)[]) {
          const s = specRef.current[k];
          if (!s) continue;
          const encoded = s.serialize(next[k] as T[typeof k]);
          const defaultEncoded = s.serialize(s.default);
          if (encoded === null || encoded === defaultEncoded) {
            params.delete(k as string);
          } else {
            params.set(k as string, encoded);
          }
        }
        return params;
      }, setOpts);
    },
    [setSearchParams, defaultMode],
  );

  return [value, setValues];
}
