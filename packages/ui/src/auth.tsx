import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { RecordModel } from "pocketbase";
import { getBackend } from "./backend";

export interface User {
  id: string;
  email: string;
  name: string;
  /** Alias for id — for compatibility with code that used Firebase's user.uid */
  uid: string;
}

function recordToUser(record: RecordModel): User {
  return {
    id: record.id,
    uid: record.id,
    email: record.email as string,
    name: (record.name as string) || (record.email as string),
  };
}

/**
 * Structural equality for the User fields we expose. PocketBase's
 * authStore.onChange fires whenever the underlying record reference
 * changes — including when our own resync() refetches the users
 * collection and re-applies the (byte-identical) snapshot. If we let
 * each of those produce a fresh User reference, every consumer with
 * `[user]` in a useEffect dep teardowns + re-runs, which thrashes
 * every wpb subscription downstream and cascades into a realtime
 * disconnect loop. Keep the prior reference when the data hasn't
 * actually changed, so consumers see stable identity.
 */
function userEquals(a: User | null, b: User | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.email === b.email && a.name === b.name;
}

/**
 * Decide whether a failed authRefresh means the credential is genuinely
 * invalid and the session should be torn down. PocketBase's SDK throws a
 * ClientResponseError with a numeric `.status`; only 401/403 mean the server
 * actively rejected the token. Everything else — a network failure (surfaces
 * as `status === 0`), a 5xx while the API pod is mid-deploy, a CORS/proxy blip
 * — is transient and must NOT log out a valid session. refresh() runs on every
 * app mount, so treating any failure as fatal logged users out the moment they
 * opened the app while offline or during a deploy.
 */
export function shouldClearAuthStore(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType>({ user: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const pb = getBackend();

    // Check if already authenticated
    if (pb.authStore.isValid && pb.authStore.record) {
      setUser(recordToUser(pb.authStore.record));
    }
    setLoading(false);

    // Listen for auth changes. Use a functional updater so we can preserve
    // the previous User reference when the underlying record's exposed
    // fields haven't actually changed — preventing every consumer with
    // [user] as a useEffect dep from thrashing on a refetch that produced
    // a byte-identical record. See userEquals above for the why.
    const unsubscribe = pb.authStore.onChange((_token, record) => {
      const next = record ? recordToUser(record) : null;
      setUser((prev) => (userEquals(prev, next) ? prev : next));
    });

    // Slide token expiry forward whenever the app is loaded or kept open.
    // PocketBase has no automatic refresh (Firebase used to do this for us),
    // so without this users get bounced to login every ~7 days regardless of
    // active use. Only clear the store when the server genuinely rejects the
    // credential (401/403) — a transient failure (offline, 5xx mid-deploy,
    // CORS blip) must NOT log out a valid session, since refresh() runs on
    // every app mount. See shouldClearAuthStore for the full reasoning.
    const refresh = async () => {
      if (!pb.authStore.isValid) return;
      try {
        await pb.collection("users").authRefresh();
      } catch (err) {
        if (shouldClearAuthStore(err)) pb.authStore.clear();
      }
    };
    refresh();
    const interval = setInterval(refresh, 6 * 60 * 60 * 1000); // every 6h

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export { AuthContext };
