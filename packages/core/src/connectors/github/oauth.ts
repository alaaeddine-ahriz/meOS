import type { OAuthTokens } from "../types.js";

/**
 * GitHub OAuth for an OAuth App whose Client ID / Client Secret the user pastes in
 * Settings (the same per-account credential model the Google connector uses). The
 * loopback callback `http://127.0.0.1:<port>/api/connectors/github/callback` must be
 * registered as the app's Authorization callback URL.
 *
 * GitHub OAuth Apps don't implement PKCE, so the `challenge` handed in by the
 * framework is ignored — the code exchange is authenticated with the client secret.
 * Classic OAuth-App tokens don't expire and carry no refresh token (we return
 * `expiry: null`, so `ensureAccessToken` never tries to refresh). If the app opts
 * into expiring user tokens, GitHub returns a refresh token + `expires_in` and the
 * refresh grant below kicks in automatically — no other change needed.
 *
 * Scopes are the minimum that lets meOS READ your repositories and the issues/PRs
 * that involve you, including private ones. GitHub OAuth Apps have no read-only
 * private scope — `repo` is the only scope that exposes private repositories — so it
 * is requested even though meOS only ever reads. `read:user` reads your profile to
 * anchor "you" in the graph and label the connected account.
 */

const AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";

export const GITHUB_SCOPES = ["read:user", "repo"];

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
    scope: GITHUB_SCOPES.join(" "),
    state: input.state,
    allow_signup: "false",
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

function tokensFromResponse(body: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}): OAuthTokens {
  // GitHub signals failures with a 200 + an `error` field, so check the body too.
  if (body.error || !body.access_token) {
    throw new Error(
      `GitHub OAuth error: ${body.error_description ?? body.error ?? "no access token"}`,
    );
  }
  const expiry =
    body.expires_in != null ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiry,
    scopes: body.scope ?? null,
  };
}

async function postToken(params: Record<string, string>): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // Without this GitHub returns a form-encoded body, not JSON.
      accept: "application/json",
    },
    body: new URLSearchParams(params),
  });
  if (!response.ok) {
    throw new Error(`GitHub token request failed (${response.status}): ${await response.text()}`);
  }
  return tokensFromResponse((await response.json()) as never);
}

/** Exchange the authorization code for tokens (PKCE verifier unused — see file note). */
export async function exchangeCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<OAuthTokens> {
  return postToken({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
}

/**
 * Mint a fresh access token from a stored refresh token. Only reached when the app
 * is configured for expiring user tokens; classic tokens never expire so this is a
 * no-op path in practice.
 */
export async function refreshAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<OAuthTokens> {
  return postToken({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
}

/**
 * Best-effort revocation on disconnect. GitHub's token-deletion endpoint requires
 * the app's client_id/secret via HTTP Basic auth, which this token-only signature
 * doesn't carry — so we no-op rather than make a call that can't succeed. Disconnect
 * still drops the stored token locally. Must never throw.
 */
export async function revokeToken(_token: string): Promise<void> {
  /* no-op: see note above */
}
