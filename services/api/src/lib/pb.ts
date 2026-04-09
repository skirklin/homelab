/**
 * PocketBase client helper.
 * Creates a PB client authenticated as the requesting user.
 */
import PocketBase from "pocketbase";

const PB_URL = process.env.PB_URL || "http://pocketbase.homelab.svc.cluster.local:8090";

export function userClient(token: string): PocketBase {
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  pb.authStore.save(token, null);
  return pb;
}
