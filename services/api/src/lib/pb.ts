/**
 * Admin PocketBase client for notification triggers and other
 * cross-user operations that need to query all records.
 */
import PocketBase from "pocketbase";

const PB_URL = process.env.PB_URL || "http://pocketbase.homelab.svc.cluster.local:8090";
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL || "";
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || "";

let adminPb: PocketBase | null = null;

export async function getAdminPb(): Promise<PocketBase> {
  if (adminPb?.authStore.isValid) return adminPb;

  if (!PB_ADMIN_EMAIL || !PB_ADMIN_PASSWORD) {
    throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD must be set");
  }

  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  await pb.collection("_superusers").authWithPassword(PB_ADMIN_EMAIL, PB_ADMIN_PASSWORD);
  adminPb = pb;
  return pb;
}
