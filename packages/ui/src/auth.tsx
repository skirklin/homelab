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

    return unsubscribe;
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
