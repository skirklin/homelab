import PocketBase from "pocketbase";

let pb: PocketBase | null = null;

export function initializeBackend(pbUrl?: string) {
  if (pb) return pb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = typeof import.meta !== "undefined" ? (import.meta as any).env : {};
  const envUrl = env?.VITE_PB_URL;
  const domain = env?.VITE_DOMAIN || "kirkl.in";
  const url = pbUrl || envUrl || `https://api.${domain}`;
  pb = new PocketBase(url);
  return pb;
}

export function getBackend(): PocketBase {
  if (!pb) throw new Error("Backend not initialized. Call initializeBackend() first.");
  return pb;
}
