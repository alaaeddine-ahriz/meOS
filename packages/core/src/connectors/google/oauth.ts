import crypto from "node:crypto";
import type { OAuthTokens } from "../types.js";

/**
 * Google OAuth for an installed "Desktop app" client, loopback + PKCE. No
 * `googleapis` dependency — raw `fetch` to the token/authorize endpoints and
 * node `crypto` for the PKCE challenge. Scopes are read-only EXCEPT Google Tasks,
 * which is read/write so meOS can create tasks on your behalf (the connector
 * framework's first explicit write capability — surfaced plainly in the UI).
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  // Tasks is READ + WRITE: meOS syncs your tasks AND can create new ones for you.
  // This is the only non-readonly scope; it's requested intentionally so the
  // create-task feature works. We never broaden beyond Tasks.
  "https://www.googleapis.com/auth/tasks",
  // profile + email let us read the account owner's own name via People people/me
  // (to anchor "knows" edges to you) and label which account is connected.
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

/** A fresh PKCE verifier/challenge pair (S256). Stash the verifier under `state`. */
export function createPkcePair(): { verifier: string; challenge: string; state: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  return { verifier, challenge, state };
}

/** Build the consent-screen URL the user opens to authorize the app. */
export function buildAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
    access_type: "offline",
    // Force a refresh token even on re-consent — Google omits it otherwise.
    prompt: "consent",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function tokensFromResponse(body: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}): OAuthTokens {
  const expiry =
    body.expires_in != null ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiry,
    scopes: body.scope ?? null,
  };
}

/** Exchange the authorization code (with its PKCE verifier) for tokens. */
export async function exchangeCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${await response.text()}`);
  }
  return tokensFromResponse((await response.json()) as never);
}

/** Mint a fresh access token from a stored refresh token. */
export async function refreshAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token refresh failed (${response.status}): ${await response.text()}`);
  }
  // A refresh response omits refresh_token; the caller keeps the existing one.
  return tokensFromResponse((await response.json()) as never);
}

/** Best-effort token revocation on disconnect. Never throws. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Offline or already-revoked — disconnect proceeds regardless.
  }
}
