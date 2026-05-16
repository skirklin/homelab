/**
 * Supabase implementation of AuthBackend.
 *
 * Synchronous getters (getCurrentUser, getToken, isAuthenticated) return
 * cached state populated by an internal onAuthStateChange subscriber that
 * fires synchronously on session rehydration from localStorage. Apps that
 * call these getters before the first tick get `null` — same UX as
 * PocketBase's `pb.authStore.record` while it restores from storage.
 *
 * Firebase parity goals (Phase 3+ enhancements, partially exposed here):
 *   - Magic-link sign-in via `signInWithMagicLink`
 *   - Password reset via `requestPasswordReset` / `updatePassword`
 *   - Email verification status surfaced on the returned User
 *   - Cross-tab session sync handled by Supabase's BroadcastChannel adapter
 *     (default on browsers).
 *
 * These extra methods are NOT yet on the AuthBackend interface (PB lacks
 * native magic-link support). Phase 3.5 widens the interface; this impl
 * already exposes them so apps can downcast when targeting Supabase.
 */
import type {
  SupabaseClient,
  User as SupabaseUser,
  AuthChangeEvent,
  Session,
  Provider,
} from "@supabase/supabase-js";
import type { AuthBackend } from "../interfaces/auth";
import type { User, Unsubscribe } from "../types/common";

function toUser(u: SupabaseUser | null | undefined): User | null {
  if (!u) return null;
  // user_metadata is freeform; fall back to email-local-part for display.
  const meta = (u.user_metadata ?? {}) as { name?: string; full_name?: string };
  const fallbackName = u.email ? u.email.split("@")[0] : u.id;
  return {
    id: u.id,
    email: u.email ?? "",
    name: meta.name ?? meta.full_name ?? fallbackName,
  };
}

export class SupabaseAuthBackend implements AuthBackend {
  private currentUser: User | null = null;
  private currentToken: string | null = null;
  private listeners = new Set<(u: User | null) => void>();

  constructor(private client: SupabaseClient) {
    // Subscribe once at construction so synchronous getters have state
    // ready by the time the app calls them. Supabase fires INITIAL_SESSION
    // on the next tick after construction with whatever it found in
    // localStorage.
    this.client.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      this.currentUser = toUser(session?.user);
      this.currentToken = session?.access_token ?? null;
      for (const cb of this.listeners) {
        try {
          cb(this.currentUser);
        } catch (err) {
          console.error("[supabase-auth] subscriber callback threw", err);
        }
      }
    });
  }

  async signInWithPassword(email: string, password: string): Promise<User> {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const user = toUser(data.user);
    if (!user) throw new Error("signInWithPassword: no user returned");
    return user;
  }

  async signUp(email: string, password: string): Promise<User> {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw error;
    const user = toUser(data.user);
    if (!user) throw new Error("signUp: no user returned (email confirmation required?)");
    return user;
  }

  async signInWithOAuth2(provider: string): Promise<User> {
    // OAuth flow redirects the browser; control returns via the redirect.
    // We kick it off and the onAuthStateChange handler picks up the user
    // after the round trip. The Promise<User> contract is awkward here —
    // it never resolves in this tab. Callers should listen via onAuthChange.
    const { error } = await this.client.auth.signInWithOAuth({
      provider: provider as Provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
    // Browser navigates away; this never resolves.
    return new Promise<User>(() => {
      /* unresolved — redirect-flow */
    });
  }

  signOut(): void {
    void this.client.auth.signOut();
  }

  getCurrentUser(): User | null {
    return this.currentUser;
  }

  isAuthenticated(): boolean {
    return this.currentUser !== null;
  }

  onAuthChange(callback: (user: User | null) => void): Unsubscribe {
    callback(this.currentUser);
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  getToken(): string | null {
    return this.currentToken;
  }

  // ----------------------------------------------------------------------
  // Firebase-parity extensions — not yet on the AuthBackend interface.
  // Callers that target Supabase specifically can use these via the
  // concrete type.
  // ----------------------------------------------------------------------

  /** Send a magic-link email. User clicks the link to land back signed-in. */
  async signInWithMagicLink(email: string, redirectTo?: string): Promise<void> {
    const { error } = await this.client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo ?? window.location.origin },
    });
    if (error) throw error;
  }

  /** Send a password-recovery email. */
  async requestPasswordReset(email: string, redirectTo?: string): Promise<void> {
    const { error } = await this.client.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo ?? window.location.origin,
    });
    if (error) throw error;
  }

  /** Set a new password for the currently signed-in user (post-recovery flow). */
  async updatePassword(newPassword: string): Promise<void> {
    const { error } = await this.client.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }
}
