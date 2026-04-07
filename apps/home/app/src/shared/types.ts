import type { User } from "@kirkl/shared";

// Re-export for convenience
export type { User };

// Auth state
export interface AuthState {
  user: User | null;
  loading: boolean;
}
