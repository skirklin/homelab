import type { User } from "firebase/auth";

// Auth state
export interface AuthState {
  user: User | null | undefined; // undefined = loading
}
