/**
 * Auth interface — login, logout, session management.
 *
 * Implementations handle the backend-specific auth flow (PocketBase auth tokens,
 * Firebase Auth, etc.) and expose a uniform API to the app.
 */
import type { User, Unsubscribe } from "../types/common";

export interface AuthBackend {
  /** Sign in with email/password. Returns the authenticated user. */
  signInWithPassword(email: string, password: string): Promise<User>;

  /** Create a new account with email/password. Returns the new user. */
  signUp(email: string, password: string): Promise<User>;

  /** Sign in via OAuth2 provider (e.g. "google"). Returns the authenticated user. */
  signInWithOAuth2(provider: string): Promise<User>;

  /** Sign out and clear stored session. */
  signOut(): void;

  /** Get the currently authenticated user, or null if not signed in. */
  getCurrentUser(): User | null;

  /** Whether a valid session exists. */
  isAuthenticated(): boolean;

  /**
   * Subscribe to auth state changes. Callback fires immediately with current state,
   * then on every login/logout.
   */
  onAuthChange(callback: (user: User | null) => void): Unsubscribe;

  /**
   * Get an opaque auth token suitable for passing to API services.
   * Returns null if not authenticated.
   */
  getToken(): string | null;
}
