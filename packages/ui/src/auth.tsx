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

    // Listen for auth changes
    const unsubscribe = pb.authStore.onChange((_token, record) => {
      setUser(record ? recordToUser(record) : null);
    });

    // Slide token expiry forward whenever the app is loaded or kept open.
    // PocketBase has no automatic refresh (Firebase used to do this for us),
    // so without this users get bounced to login every ~7 days regardless of
    // active use. Failures clear the store, so an actually-expired token
    // funnels the user through the login screen as expected.
    const refresh = async () => {
      if (!pb.authStore.isValid) return;
      try {
        await pb.collection("users").authRefresh();
      } catch {
        pb.authStore.clear();
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
