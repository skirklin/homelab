import PocketBase from "pocketbase";

let pb: PocketBase | null = null;

export function initializeBackend(pbUrl?: string) {
  if (pb) return pb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envUrl = typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_PB_URL;
  const url = pbUrl || envUrl || "https://api.beta.kirkl.in";
  pb = new PocketBase(url);
  return pb;
}

export function getBackend(): PocketBase {
  if (!pb) throw new Error("Backend not initialized. Call initializeBackend() first.");
  return pb;
}
