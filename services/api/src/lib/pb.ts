/**
 * Admin PocketBase client for notification triggers and other
 * cross-user operations that need to query all records.
 */
import PocketBase from "pocketbase";

let adminPb: PocketBase | null = null;

export async function getAdminPb(): Promise<PocketBase> {
  if (adminPb?.authStore.isValid) return adminPb;

  const pbUrl = process.env.PB_URL || "http://pocketbase.homelab.svc.cluster.local:8090";
  const email = process.env.PB_ADMIN_EMAIL || "";
  const password = process.env.PB_ADMIN_PASSWORD || "";

  if (!email || !password) {
    throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD must be set");
  }

  const pb = new PocketBase(pbUrl);
  pb.autoCancellation(false);
  await pb.collection("_superusers").authWithPassword(email, password);
  adminPb = pb;
  return pb;
}
