/** Drop keys whose value is `undefined` (keeps `null`). Used to build PATCH bodies. */
export function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
