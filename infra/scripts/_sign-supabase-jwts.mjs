#!/usr/bin/env node
// Sign the anon + service_role JWTs that Kong, PostgREST, Realtime, and Studio
// all expect. HS256 over the JWT_SECRET supplied via env.
//
// Inputs (env):
//   JWT_SECRET — shared HS256 key (kept in the supabase-secrets k8s Secret)
//   JWT_EXP_SECONDS — optional; default 10 years
//
// Output: prints two lines to stdout:
//   ANON_KEY=<jwt>
//   SERVICE_ROLE_KEY=<jwt>
//
// Called by bootstrap-supabase-secrets.sh. No secret values are written to
// disk by this script.

import crypto from "node:crypto";

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error("JWT_SECRET must be set and >= 32 chars");
  process.exit(1);
}

const exp = Number(process.env.JWT_EXP_SECONDS ?? 60 * 60 * 24 * 365 * 10);
const iat = Math.floor(Date.now() / 1000);

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sign(role) {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { role, iss: "supabase", iat, exp: iat + exp };
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${head}.${body}`;
  const sig = crypto.createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

process.stdout.write(`ANON_KEY=${sign("anon")}\n`);
process.stdout.write(`SERVICE_ROLE_KEY=${sign("service_role")}\n`);
