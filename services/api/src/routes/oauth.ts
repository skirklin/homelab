import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import PocketBase from "pocketbase";

import { getAdminPb } from "../lib/pb";
import {
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_SEC,
  AUTH_CODE_TTL_SEC,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_TTL_SEC,
  SUPPORTED_SCOPES,
  buildErrorRedirect,
  buildSuccessRedirect,
  checkRateLimit,
  generateOpaqueToken,
  getClientIp,
  isAllowedRedirectUri,
  sha256Hex,
  verifyPkceS256,
} from "../lib/oauth";

const oauth = new Hono();

const PB_URL = () => process.env.PB_URL || "http://pocketbase.homelab.svc.cluster.local:8090";

// ---------- Dynamic Client Registration (RFC 7591) ----------

const RegisterReq = z.object({
  client_name: z.string().min(1),
  redirect_uris: z.array(z.string().url()).min(1),
  token_endpoint_auth_method: z.enum(["none", "client_secret_basic", "client_secret_post"]).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
});

oauth.post("/register", async (c) => {
  const ip = getClientIp((n) => c.req.header(n));
  if (!checkRateLimit(`register:${ip}`, 10, 60_000)) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = RegisterReq.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_client_metadata", error_description: parsed.error.message }, 400);
  }

  const disallowed = parsed.data.redirect_uris.filter((u) => !isAllowedRedirectUri(u));
  if (disallowed.length > 0) {
    return c.json({
      error: "invalid_redirect_uri",
      error_description: `redirect_uri must be loopback (http://localhost or http://127.0.0.1) or an Anthropic-owned host (claude.ai, *.anthropic.com); rejected: ${disallowed.join(", ")}`,
    }, 400);
  }

  const adminPb = await getAdminPb();
  const clientId = generateOpaqueToken("mcpc_", 16);
  const authMethod = parsed.data.token_endpoint_auth_method ?? "none";
  let clientSecret: string | undefined;
  let clientSecretHash: string | undefined;
  if (authMethod !== "none") {
    clientSecret = generateOpaqueToken("mcps_", 32);
    clientSecretHash = sha256Hex(clientSecret);
  }

  const record = await adminPb.collection("oauth_clients").create({
    client_id: clientId,
    client_secret_hash: clientSecretHash ?? "",
    client_name: parsed.data.client_name,
    redirect_uris: parsed.data.redirect_uris,
    token_endpoint_auth_method: authMethod,
    grant_types: parsed.data.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: parsed.data.response_types ?? ["code"],
    scope: parsed.data.scope ?? SUPPORTED_SCOPES.join(" "),
  });

  return c.json({
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    client_id_issued_at: Math.floor(new Date(record.created).getTime() / 1000),
    client_name: parsed.data.client_name,
    redirect_uris: parsed.data.redirect_uris,
    token_endpoint_auth_method: authMethod,
    grant_types: parsed.data.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: parsed.data.response_types ?? ["code"],
    scope: parsed.data.scope ?? SUPPORTED_SCOPES.join(" "),
  }, 201);
});

// ---------- /authorize: GET shows login/consent, POST processes consent ----------

type AuthorizeParams = {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  state?: string;
  scope?: string;
  code_challenge: string;
  code_challenge_method: string;
  resource?: string;
};

function readAuthorizeParams(query: Record<string, string | undefined>): AuthorizeParams | { error: string } {
  const required = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method"] as const;
  for (const k of required) {
    if (!query[k]) return { error: `missing ${k}` };
  }
  if (query.response_type !== "code") return { error: "unsupported response_type (only 'code' supported)" };
  if (query.code_challenge_method !== "S256") return { error: "code_challenge_method must be S256" };
  return {
    client_id: query.client_id!,
    redirect_uri: query.redirect_uri!,
    response_type: query.response_type!,
    state: query.state,
    scope: query.scope,
    code_challenge: query.code_challenge!,
    code_challenge_method: query.code_challenge_method!,
    resource: query.resource,
  };
}

type AdminPb = Awaited<ReturnType<typeof getAdminPb>>;
type LoadClientResult =
  | { ok: true; client: Record<string, unknown> & { id: string }; adminPb: AdminPb }
  | { ok: false; error: string };

async function loadClientForAuthorize(clientId: string, redirectUri: string): Promise<LoadClientResult> {
  const adminPb = await getAdminPb();
  let record;
  try {
    record = await adminPb.collection("oauth_clients").getFirstListItem(
      adminPb.filter("client_id = {:cid}", { cid: clientId }),
    );
  } catch {
    return { ok: false, error: "unknown client" };
  }
  const allowed = (record.redirect_uris ?? []) as string[];
  if (!allowed.includes(redirectUri)) {
    return { ok: false, error: "redirect_uri not registered for this client" };
  }
  return { ok: true, client: record as Record<string, unknown> & { id: string }, adminPb };
}

/** Validate a session cookie by hitting PB authRefresh. Returns the user record on success. */
async function userFromSessionCookie(token: string | undefined): Promise<{ id: string; email: string } | null> {
  if (!token) return null;
  try {
    const pb = new PocketBase(PB_URL());
    pb.autoCancellation(false);
    pb.authStore.save(token, null);
    const result = await pb.collection("users").authRefresh({ $autoCancel: false });
    return { id: result.record.id, email: (result.record.email as string) ?? "" };
  } catch {
    return null;
  }
}

function htmlPage(body: string, extraHead = ""): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>homelab — authorize</title><style>
:root { color-scheme: light dark; }
body { font: 16px system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; }
h1 { font-size: 1.25rem; margin-bottom: 1rem; }
form { display: flex; flex-direction: column; gap: .75rem; }
input, button { font: inherit; padding: .6rem .75rem; border: 1px solid #888; border-radius: .375rem; background: transparent; color: inherit; }
button { cursor: pointer; }
button.primary { background: #2563eb; color: white; border-color: #2563eb; }
button.danger { background: transparent; color: #b91c1c; border-color: #b91c1c; }
button.google { background: white; color: #1f2937; border-color: #d1d5db; }
.row { display: flex; gap: .5rem; }
.row > * { flex: 1; }
.muted { color: #666; font-size: .875rem; }
.err { color: #b91c1c; margin: .5rem 0; }
.box { padding: 1rem; border: 1px solid #888; border-radius: .5rem; margin: 1rem 0; }
.divider { display: flex; align-items: center; gap: .5rem; margin: 1rem 0; color: #888; font-size: .875rem; }
.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #ccc; }
</style>${extraHead}</head><body>${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderHiddenFields(params: AuthorizeParams): string {
  const entries: [string, string | undefined][] = [
    ["client_id", params.client_id],
    ["redirect_uri", params.redirect_uri],
    ["response_type", params.response_type],
    ["state", params.state],
    ["scope", params.scope],
    ["code_challenge", params.code_challenge],
    ["code_challenge_method", params.code_challenge_method],
    ["resource", params.resource],
  ];
  return entries
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v!)}">`)
    .join("");
}

oauth.get("/authorize", async (c) => {
  const query = c.req.query();
  const parsed = readAuthorizeParams(query);
  if ("error" in parsed) return c.text(parsed.error, 400);

  const clientResult = await loadClientForAuthorize(parsed.client_id, parsed.redirect_uri);
  if (!clientResult.ok) return c.text(clientResult.error, 400);

  const requestedScopes = (parsed.scope?.split(/\s+/).filter(Boolean) ?? ["mcp"]);
  const invalid = requestedScopes.filter((s) => !SUPPORTED_SCOPES.includes(s));
  if (invalid.length) {
    return c.redirect(buildErrorRedirect(parsed.redirect_uri, "invalid_scope", parsed.state, `unsupported scopes: ${invalid.join(", ")}`));
  }

  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
  const user = await userFromSessionCookie(sessionToken);
  const hidden = renderHiddenFields(parsed);
  const clientName = escapeHtml((clientResult.client.client_name as string) ?? "Unknown client");
  const scopeList = requestedScopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("");

  if (!user) {
    const pbUrl = process.env.PB_PUBLIC_URL || "https://api.kirkl.in";
    return c.html(htmlPage(`
      <h1>Sign in to homelab</h1>
      <p class="muted"><strong>${clientName}</strong> wants to access your homelab data.</p>
      <button id="google-signin" class="google" type="button">
        <span style="font-weight:500">Sign in with Google</span>
      </button>
      <p id="google-err" class="err" style="display:none"></p>
      <div class="divider">or with email</div>
      <form method="POST" action="/oauth/login">
        ${hidden}
        <input name="email" type="email" placeholder="email" autocomplete="email" required>
        <input name="password" type="password" placeholder="password" autocomplete="current-password" required>
        <button type="submit" class="primary">Sign in</button>
      </form>
      <script src="https://cdn.jsdelivr.net/npm/pocketbase@0.25.0/dist/pocketbase.umd.js"></script>
      <script>
      (function() {
        const btn = document.getElementById("google-signin");
        const err = document.getElementById("google-err");
        btn.addEventListener("click", async () => {
          err.style.display = "none";
          btn.disabled = true;
          btn.textContent = "Opening Google...";
          try {
            // Use the same PB instance the home app uses; PB orchestrates the popup
            // and returns the session token.
            const pb = new PocketBase(${JSON.stringify(pbUrl)});
            const authData = await pb.collection("users").authWithOAuth2({ provider: "google" });
            // Hand the token to our server, which validates it and sets the session cookie.
            const resp = await fetch("/oauth/cookie-set", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: authData.token }),
            });
            if (!resp.ok) throw new Error("server rejected token (" + resp.status + ")");
            // Reload to re-render the consent screen with the new cookie.
            window.location.reload();
          } catch (e) {
            err.textContent = (e && e.message) || "Google sign-in failed";
            err.style.display = "block";
            btn.disabled = false;
            btn.textContent = "Sign in with Google";
          }
        });
      })();
      </script>
    `));
  }

  return c.html(htmlPage(`
    <h1>Authorize ${clientName}</h1>
    <p class="muted">Signed in as <strong>${escapeHtml(user.email)}</strong>.</p>
    <div class="box">
      <p><strong>${clientName}</strong> is requesting:</p>
      <ul>${scopeList}</ul>
    </div>
    <form method="POST" action="/oauth/authorize">
      ${hidden}
      <div class="row">
        <button type="submit" name="decision" value="deny" class="danger">Deny</button>
        <button type="submit" name="decision" value="approve" class="primary">Approve</button>
      </div>
    </form>
  `));
});

// Bridge endpoint used by the Google sign-in script on /oauth/authorize:
// the page completes PocketBase's popup-based OAuth flow client-side, then
// POSTs the resulting PB session token here so we can set the session cookie
// for the /oauth/* path. Lets users sign in with Google without us having to
// register a new redirect URL with Google or proxy the OAuth code exchange.
oauth.post("/cookie-set", async (c) => {
  const ip = getClientIp((n) => c.req.header(n));
  if (!checkRateLimit(`cookie-set:${ip}`, 10, 60_000)) return c.json({ error: "rate_limited" }, 429);
  const body = await c.req.json().catch(() => null);
  const token = (body && typeof body === "object" && typeof (body as { token?: unknown }).token === "string")
    ? (body as { token: string }).token
    : "";
  if (!token) return c.json({ error: "missing token" }, 400);
  const user = await userFromSessionCookie(token);
  if (!user) return c.json({ error: "invalid token" }, 401);
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/oauth",
    maxAge: SESSION_COOKIE_TTL_SEC,
  });
  return c.body(null, 204);
});

oauth.post("/login", async (c) => {
  const ip = getClientIp((n) => c.req.header(n));
  if (!checkRateLimit(`login:${ip}`, 5, 60_000)) {
    return c.html(htmlPage(`<h1>Too many attempts</h1><p class="err">Slow down — try again in a minute.</p>`), 429);
  }
  const form = await c.req.parseBody();
  const email = String(form.email ?? "");
  const password = String(form.password ?? "");
  if (!email || !password) return c.text("email + password required", 400);

  let token: string;
  try {
    const pb = new PocketBase(PB_URL());
    pb.autoCancellation(false);
    const result = await pb.collection("users").authWithPassword(email, password, { $autoCancel: false });
    token = result.token;
  } catch {
    return c.html(htmlPage(`<h1>Sign-in failed</h1><p class="err">Invalid email or password.</p><p><a href="javascript:history.back()">Back</a></p>`), 401);
  }

  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/oauth",
    maxAge: SESSION_COOKIE_TTL_SEC,
  });

  // Re-render the consent screen by issuing a redirect back to /authorize with the same params.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (k === "email" || k === "password") continue;
    if (typeof v === "string") params.set(k, v);
  }
  return c.redirect(`/oauth/authorize?${params.toString()}`);
});

oauth.post("/authorize", async (c) => {
  const form = await c.req.parseBody();
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string") flat[k] = v;
  }
  const parsed = readAuthorizeParams(flat);
  if ("error" in parsed) return c.text(parsed.error, 400);

  const clientResult = await loadClientForAuthorize(parsed.client_id, parsed.redirect_uri);
  if (!clientResult.ok) return c.text(clientResult.error, 400);

  const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
  const user = await userFromSessionCookie(sessionToken);
  if (!user) return c.text("not signed in", 401);

  const decision = String(form.decision ?? "");
  if (decision !== "approve") {
    return c.redirect(buildErrorRedirect(parsed.redirect_uri, "access_denied", parsed.state));
  }

  const code = generateOpaqueToken("mcpcd_", 32);
  const codeHash = sha256Hex(code);
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000).toISOString();

  await clientResult.adminPb.collection("oauth_codes").create({
    code_hash: codeHash,
    client: clientResult.client.id,
    user: user.id,
    redirect_uri: parsed.redirect_uri,
    code_challenge: parsed.code_challenge,
    code_challenge_method: parsed.code_challenge_method,
    scope: parsed.scope ?? SUPPORTED_SCOPES.join(" "),
    resource: parsed.resource ?? "",
    expires_at: expiresAt,
    consumed: false,
  });

  return c.redirect(buildSuccessRedirect(parsed.redirect_uri, code, parsed.state));
});

// ---------- /token: authorization_code + refresh_token grants ----------

type LoadClientForTokenResult =
  | { ok: true; client: Record<string, unknown> & { id: string }; adminPb: AdminPb }
  | { ok: false; error: "invalid_client" };

async function loadClientForToken(clientId: string, providedSecret: string | undefined): Promise<LoadClientForTokenResult> {
  const adminPb = await getAdminPb();
  let record;
  try {
    record = await adminPb.collection("oauth_clients").getFirstListItem(
      adminPb.filter("client_id = {:cid}", { cid: clientId }),
    );
  } catch {
    return { ok: false, error: "invalid_client" };
  }
  const method = record.token_endpoint_auth_method as string;
  if (method !== "none") {
    const expected = (record.client_secret_hash as string) ?? "";
    if (!providedSecret || sha256Hex(providedSecret) !== expected) {
      return { ok: false, error: "invalid_client" };
    }
  }
  return { ok: true, client: record as Record<string, unknown> & { id: string }, adminPb };
}

oauth.post("/token", async (c) => {
  const ip = getClientIp((n) => c.req.header(n));
  if (!checkRateLimit(`token:${ip}`, 30, 60_000)) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const form = await c.req.parseBody();

  // Client auth: prefer Authorization: Basic, fall back to form params.
  const authHeader = c.req.header("Authorization") ?? "";
  let basicClientId: string | undefined;
  let basicSecret: string | undefined;
  if (authHeader.startsWith("Basic ")) {
    try {
      const [u, p] = Buffer.from(authHeader.slice(6), "base64").toString("utf-8").split(":");
      basicClientId = decodeURIComponent(u);
      basicSecret = decodeURIComponent(p ?? "");
    } catch {
      // fall through to form
    }
  }
  const clientId = basicClientId ?? String(form.client_id ?? "");
  const clientSecret = basicSecret ?? (form.client_secret != null ? String(form.client_secret) : undefined);
  if (!clientId) return c.json({ error: "invalid_client", error_description: "missing client_id" }, 401);

  const clientResult = await loadClientForToken(clientId, clientSecret);
  if (!clientResult.ok) return c.json({ error: clientResult.error }, 401);
  const { client, adminPb } = clientResult;

  const grantType = String(form.grant_type ?? "");
  if (grantType === "authorization_code") {
    const code = String(form.code ?? "");
    const codeVerifier = String(form.code_verifier ?? "");
    const redirectUri = String(form.redirect_uri ?? "");
    if (!code || !codeVerifier || !redirectUri) {
      return c.json({ error: "invalid_request", error_description: "code, code_verifier, redirect_uri required" }, 400);
    }
    const codeHash = sha256Hex(code);
    let codeRec;
    try {
      codeRec = await adminPb.collection("oauth_codes").getFirstListItem(
        adminPb.filter("code_hash = {:h}", { h: codeHash }),
      );
    } catch {
      return c.json({ error: "invalid_grant", error_description: "code not found" }, 400);
    }
    if (codeRec.consumed) return c.json({ error: "invalid_grant", error_description: "code already used" }, 400);
    if (new Date(codeRec.expires_at as string) < new Date()) return c.json({ error: "invalid_grant", error_description: "code expired" }, 400);
    if (codeRec.client !== client.id) return c.json({ error: "invalid_grant", error_description: "code/client mismatch" }, 400);
    if (codeRec.redirect_uri !== redirectUri) return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    if (!verifyPkceS256(codeVerifier, codeRec.code_challenge as string)) {
      return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }

    // Single-use: mark consumed before issuing tokens.
    await adminPb.collection("oauth_codes").update(codeRec.id, { consumed: true });

    return issueTokens(c, adminPb, {
      clientPk: client.id,
      userPk: codeRec.user as string,
      scope: (codeRec.scope as string) ?? SUPPORTED_SCOPES.join(" "),
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(form.refresh_token ?? "");
    if (!refreshToken) return c.json({ error: "invalid_request", error_description: "refresh_token required" }, 400);
    const hash = sha256Hex(refreshToken);
    let rec;
    try {
      rec = await adminPb.collection("oauth_refresh_tokens").getFirstListItem(
        adminPb.filter("token_hash = {:h}", { h: hash }),
      );
    } catch {
      return c.json({ error: "invalid_grant", error_description: "refresh token not found" }, 400);
    }
    if (rec.revoked) return c.json({ error: "invalid_grant", error_description: "refresh token revoked" }, 400);
    if (new Date(rec.expires_at as string) < new Date()) return c.json({ error: "invalid_grant", error_description: "refresh token expired" }, 400);
    if (rec.client !== client.id) return c.json({ error: "invalid_grant", error_description: "client mismatch" }, 400);

    return issueTokens(c, adminPb, {
      clientPk: client.id,
      userPk: rec.user as string,
      scope: (rec.scope as string) ?? SUPPORTED_SCOPES.join(" "),
    });
  }

  return c.json({ error: "unsupported_grant_type" }, 400);
});

async function issueTokens(
  c: Context,
  adminPb: Awaited<ReturnType<typeof getAdminPb>>,
  ctx: { clientPk: string; userPk: string; scope: string },
) {
  const accessToken = generateOpaqueToken("mcpat_", 32);
  const refreshToken = generateOpaqueToken("mcprt_", 48);
  const accessExp = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000).toISOString();
  const refreshExp = new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000).toISOString();

  await adminPb.collection("oauth_access_tokens").create({
    token_hash: sha256Hex(accessToken),
    token_prefix: accessToken.slice(0, 16),
    client: ctx.clientPk,
    user: ctx.userPk,
    scope: ctx.scope,
    expires_at: accessExp,
  });
  await adminPb.collection("oauth_refresh_tokens").create({
    token_hash: sha256Hex(refreshToken),
    token_prefix: refreshToken.slice(0, 16),
    client: ctx.clientPk,
    user: ctx.userPk,
    scope: ctx.scope,
    expires_at: refreshExp,
    revoked: false,
  });

  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshToken,
    scope: ctx.scope,
  });
}

// ---------- /revoke (RFC 7009) ----------

oauth.post("/revoke", async (c) => {
  const form = await c.req.parseBody();
  const token = String(form.token ?? "");
  if (!token) return c.body(null, 200); // RFC 7009: respond 200 even when token is missing/unknown

  const hash = sha256Hex(token);
  const adminPb = await getAdminPb();
  for (const collection of ["oauth_access_tokens", "oauth_refresh_tokens"]) {
    try {
      const rec = await adminPb.collection(collection).getFirstListItem(
        adminPb.filter("token_hash = {:h}", { h: hash }),
      );
      if (collection === "oauth_refresh_tokens") {
        await adminPb.collection(collection).update(rec.id, { revoked: true });
      } else {
        await adminPb.collection(collection).delete(rec.id);
      }
      break;
    } catch {
      // not found in this collection, try the next
    }
  }
  return c.body(null, 200);
});

export { oauth as oauthRoutes };
