/**
 * Export all Firestore data to JSON files.
 * Creates a snapshot directory with one JSON file per collection.
 *
 * Usage: npx tsx export-firebase.ts [--output-dir <dir>]
 */
import admin from "firebase-admin";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

admin.initializeApp({
  credential: admin.credential.cert("/home/skirklin/projects/firebase/service-account.json"),
  projectId: "recipe-box-335721",
});
const db = admin.firestore();

const outputDir = process.argv.includes("--output-dir")
  ? process.argv[process.argv.indexOf("--output-dir") + 1]
  : "";

if (!outputDir) {
  console.error("Error: --output-dir is required");
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

function serialize(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof (val as any).toDate === "function") {
      result[key] = { __type: "timestamp", value: (val as any).toDate().toISOString() };
    } else if (val && typeof (val as any).id === "string" && typeof (val as any).path === "string") {
      result[key] = { __type: "ref", id: (val as any).id, path: (val as any).path };
    } else if (Array.isArray(val)) {
      result[key] = val.map(v => {
        if (v && typeof v.toDate === "function") return { __type: "timestamp", value: v.toDate().toISOString() };
        if (v && typeof v.id === "string" && typeof v.path === "string") return { __type: "ref", id: v.id, path: v.path };
        if (v && typeof v === "object") return serialize(v as Record<string, unknown>);
        return v;
      });
    } else if (val && typeof val === "object" && !(val instanceof Date)) {
      result[key] = serialize(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

interface CollectionSpec {
  path: string;
  subcollections?: { name: string; }[];
}

const collections: CollectionSpec[] = [
  { path: "boxes", subcollections: [{ name: "recipes" }, { name: "events" }] },
  { path: "lists", subcollections: [{ name: "items" }, { name: "history" }, { name: "trips" }] },
  { path: "lifeLogs", subcollections: [{ name: "events" }] },
  { path: "taskLists", subcollections: [{ name: "tasks" }, { name: "events" }] },
  { path: "travelLogs", subcollections: [{ name: "trips" }, { name: "activities" }, { name: "itineraries" }] },
  { path: "users" },
];

// Export Firebase Auth users too
console.log("=== Exporting Firebase Auth users ===");
const authUsers: Record<string, unknown>[] = [];
let nextPageToken: string | undefined;
do {
  const result = await admin.auth().listUsers(1000, nextPageToken);
  for (const user of result.users) {
    authUsers.push({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      providerData: user.providerData.map(p => ({ providerId: p.providerId, email: p.email })),
    });
  }
  nextPageToken = result.pageToken;
} while (nextPageToken);
writeFileSync(join(outputDir, "_auth_users.json"), JSON.stringify(authUsers, null, 2));
console.log(`  ${authUsers.length} auth users`);

// Export collections
for (const spec of collections) {
  console.log(`\n=== Exporting ${spec.path} ===`);
  const snapshot = await db.collection(spec.path).get();
  const docs: Record<string, unknown>[] = [];

  for (const doc of snapshot.docs) {
    const entry: Record<string, unknown> = {
      _id: doc.id,
      ...serialize(doc.data()),
    };

    // Export subcollections
    if (spec.subcollections) {
      for (const sub of spec.subcollections) {
        const subSnap = await db.collection(spec.path).doc(doc.id).collection(sub.name).get();
        entry[`_sub_${sub.name}`] = subSnap.docs.map(d => ({
          _id: d.id,
          ...serialize(d.data()),
        }));
      }
    }

    docs.push(entry);
  }

  writeFileSync(join(outputDir, `${spec.path}.json`), JSON.stringify(docs, null, 2));

  const subCounts = spec.subcollections
    ? spec.subcollections.map(s => {
        const total = docs.reduce((sum, d) => sum + ((d[`_sub_${s.name}`] as any[])?.length || 0), 0);
        return `${s.name}=${total}`;
      }).join(", ")
    : "";
  console.log(`  ${docs.length} docs${subCounts ? ` (${subCounts})` : ""}`);
}

console.log(`\n=== Export complete: ${outputDir} ===`);
process.exit(0);
