/**
 * `PocketBaseSessionStore` — `SessionStore` adapter that mirrors
 * `@anthropic-ai/claude-agent-sdk` session-transcript state to PocketBase.
 *
 * The SDK calls the adapter:
 *
 *   - `append(key, entries[])` — append a batch of transcript entries under
 *     `(projectKey, sessionId, subpath?)`.
 *   - `load(key)` — fetch the full entries array for resume; `null` if
 *     never written.
 *   - `delete(key)` — delete a session's entries (optional in the
 *     interface; we implement it).
 *   - `listSessions(projectKey)` — enumerate sessions in a project; uses
 *     `last_activity` as the mtime.
 *   - `listSubkeys({projectKey, sessionId})` — enumerate non-main
 *     transcripts (subagents) under a session.
 *
 * Storage shape (PB `coach_sessions` collection — see migration
 * `20260608_181214_coach_sessions.js`):
 *
 *   { owner, project_key, session_id, subpath, entries, last_activity }
 *
 * Each adapter instance is bound to a single PB user (`owner`) — the
 * coach service spins up one SessionStore per user it serves. This
 * keeps the tenancy boundary inside the adapter so the SDK never needs
 * to know about it.
 *
 * Uniqueness is enforced by the migration's compound unique index
 * `(owner, project_key, session_id, subpath)`. `subpath` is stored as
 * `""` for main transcripts (SDK uses `undefined`) so the index works
 * cleanly under sqlite — we normalize at the adapter boundary.
 *
 * Concurrency: `append` does a read-modify-write under no transactional
 * guard. For D1 this is fine — a single coach pod has at most one
 * in-flight `query()` per user at a time, so there's no append-vs-append
 * race. If D2's inbox-queue pattern ever turns into multi-flight calls,
 * this becomes the place to add a per-key lock or a PB-side optimistic
 * concurrency check (an `updated` etag round-trip).
 *
 * Admin-PB rationale: the coach service runs as a trusted backend and
 * `coach_sessions` rules require `owner = @request.auth.id`. To write on
 * the user's behalf without holding a user JWT, the adapter takes an
 * admin-authenticated PocketBase client. The `owner` field on each row
 * is the only tenancy gate — set explicitly at construction time, not
 * derivable from request context.
 */
import type PocketBase from "pocketbase";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

const COLLECTION = "coach_sessions";

/**
 * Normalize `subpath` to a non-null string. The SDK uses `undefined` for
 * main transcripts; PB's compound unique index needs a concrete value so
 * "no subpath" can collide with itself.
 */
function normSubpath(s: string | undefined): string {
  return s ?? "";
}

interface CoachSessionRow {
  id: string;
  owner: string;
  project_key: string;
  session_id: string;
  subpath: string;
  entries: SessionStoreEntry[] | null;
  last_activity: string;
}

export interface PocketBaseSessionStoreOptions {
  /** Admin-authenticated PocketBase client. Bypasses owner rules. */
  pb: PocketBase;
  /** PB user record id that owns every row written through this adapter. */
  ownerId: string;
}

export class PocketBaseSessionStore implements SessionStore {
  private readonly pb: PocketBase;
  private readonly ownerId: string;

  constructor(opts: PocketBaseSessionStoreOptions) {
    if (!opts.ownerId) {
      throw new Error("PocketBaseSessionStore requires an ownerId");
    }
    this.pb = opts.pb;
    this.ownerId = opts.ownerId;
  }

  /**
   * Find an existing row for this key, or null. PB returns 404 (thrown)
   * when the filter matches nothing — we translate to a clean `null` so
   * the rest of the adapter doesn't have to wrap every call in try/catch.
   */
  private async findRow(key: SessionKey): Promise<CoachSessionRow | null> {
    const subpath = normSubpath(key.subpath);
    try {
      const row = await this.pb
        .collection(COLLECTION)
        .getFirstListItem(
          this.pb.filter(
            "owner = {:owner} && project_key = {:pk} && session_id = {:sid} && subpath = {:sp}",
            {
              owner: this.ownerId,
              pk: key.projectKey,
              sid: key.sessionId,
              sp: subpath,
            },
          ),
        );
      return row as unknown as CoachSessionRow;
    } catch (e: unknown) {
      // PB SDK throws ClientResponseError with .status === 404 for not-found.
      // Anything else (network, auth, 5xx) bubbles — adapter contract says
      // rejection is retried by the SDK; silent swallow would lose data.
      const status = (e as { status?: number } | null)?.status;
      if (status === 404) return null;
      throw e;
    }
  }

  /**
   * SDK contract: append entries, treating `uuid` as an idempotency key
   * when present. Within a single process we serialize on the read-then-write
   * pattern below; cross-process concurrency is the future-D2 problem (see
   * file header).
   *
   * Entries WITHOUT `uuid` are appended unconditionally; entries WITH `uuid`
   * are deduped against the existing array. This matches the
   * `InMemorySessionStore` behavior implied by the SDK docs.
   */
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const existing = await this.findRow(key);

    if (!existing) {
      // First write for this key — create the row. The unique index on
      // (owner, project_key, session_id, subpath) protects against a
      // racing create-create.
      await this.pb.collection(COLLECTION).create({
        owner: this.ownerId,
        project_key: key.projectKey,
        session_id: key.sessionId,
        subpath: normSubpath(key.subpath),
        entries,
      });
      return;
    }

    const current: SessionStoreEntry[] = Array.isArray(existing.entries)
      ? existing.entries
      : [];
    const seenUuids = new Set<string>();
    for (const e of current) {
      if (typeof e.uuid === "string") seenUuids.add(e.uuid);
    }
    const additions: SessionStoreEntry[] = [];
    for (const e of entries) {
      if (typeof e.uuid === "string") {
        if (seenUuids.has(e.uuid)) continue;
        seenUuids.add(e.uuid);
      }
      additions.push(e);
    }
    if (additions.length === 0) return;

    await this.pb.collection(COLLECTION).update(existing.id, {
      entries: current.concat(additions),
    });
  }

  /**
   * SDK contract: return the entries array, or `null` if the key was
   * never written.
   */
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const row = await this.findRow(key);
    if (!row) return null;
    return Array.isArray(row.entries) ? row.entries : [];
  }

  /**
   * SDK contract: list `{sessionId, mtime}` for the project. We use the
   * row's `last_activity` (autodate, touched on every write) as the
   * mtime — matches the SDK's "shares a clock source with append" rule.
   *
   * We list only main transcripts (`subpath = ""`) — `listSessions` is
   * a session-id enumeration, not a transcript enumeration; subagents
   * are surfaced via `listSubkeys`.
   */
  async listSessions(
    projectKey: string,
  ): Promise<Array<{ sessionId: string; mtime: number }>> {
    const rows = await this.pb.collection(COLLECTION).getFullList({
      filter: this.pb.filter(
        'owner = {:owner} && project_key = {:pk} && subpath = ""',
        { owner: this.ownerId, pk: projectKey },
      ),
      fields: "session_id,last_activity",
    });
    return (rows as unknown as Array<{ session_id: string; last_activity: string }>).map(
      (r) => ({
        sessionId: r.session_id,
        mtime: new Date(r.last_activity).getTime(),
      }),
    );
  }

  /**
   * SDK contract: list non-empty subpaths for a session (subagent
   * transcripts). Returns just the subpath strings.
   */
  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    const rows = await this.pb.collection(COLLECTION).getFullList({
      filter: this.pb.filter(
        'owner = {:owner} && project_key = {:pk} && session_id = {:sid} && subpath != ""',
        { owner: this.ownerId, pk: key.projectKey, sid: key.sessionId },
      ),
      fields: "subpath",
    });
    return (rows as unknown as Array<{ subpath: string }>).map((r) => r.subpath);
  }

  /**
   * SDK contract: delete the row for this key. No-op if not found.
   */
  async delete(key: SessionKey): Promise<void> {
    const row = await this.findRow(key);
    if (!row) return;
    await this.pb.collection(COLLECTION).delete(row.id);
  }
}
