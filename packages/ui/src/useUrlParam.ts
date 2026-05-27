import { useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

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
 * Bind a single URL search param to a typed value.
 *
 * - Reading: `parse(searchParams.get(name))` runs on every render.
 * - Writing: calls `serialize(value)`; if the result equals `serialize(default)` or is `null`,
 *   the param is removed (default-not-written-by-construction).
 * - Mode: `"replace"` (default) uses `setSearchParams(..., { replace: true })`; `"push"` omits the flag.
 * - Debounce: when provided, the setter coalesces writes so the URL only updates `debounce`ms after
 *   the last call. Pending timers are cancelled on the next call and on unmount. The reader is
 *   un-debounced — callers that want instant local feedback should keep a `useState` mirror and
 *   let the URL lag behind.
 */
export function useUrlParam<T>(
  name: string,
  opts: UseUrlParamOptions<T>,
): [T, (value: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const { parse, serialize, debounce, mode = "replace" } = opts;

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
    (next: T) => {
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
    [name, serialize, setSearchParams, mode],
  );

  const setValue = useCallback(
    (next: T) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (debounce && debounce > 0) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          commit(next);
        }, debounce);
      } else {
        commit(next);
      }
    },
    [commit, debounce],
  );

  return [value, setValue];
}
