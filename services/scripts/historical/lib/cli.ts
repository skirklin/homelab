/**
 * Shared argv helpers for the one-shot history rewrite scripts
 * (merge-sleep-quality.ts / split-category-subjects.ts).
 *
 * Both mutate `argv` in place (splice out what they consume) so the caller
 * can reject leftovers as unknown args afterwards.
 */

/**
 * Consume `--name value` from argv. Returns undefined when the option is
 * absent. Throws when the option is present but has no value (last arg, or
 * immediately followed by another --flag) — silently treating `--log` with
 * no value as "all logs" is exactly the wrong default for a history rewrite.
 */
export function takeOpt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const val = argv[i + 1];
  if (val === undefined || val.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  argv.splice(i, 2);
  return val;
}

/** Consume a bare `--name` flag from argv. */
export function takeFlag(argv: string[], name: string): boolean {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}
