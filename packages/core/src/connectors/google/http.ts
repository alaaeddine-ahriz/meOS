/** Sentinel thrown when Google reports a sync token expired (HTTP 410 GONE). */
export class SyncTokenExpiredError extends Error {
  constructor() {
    super("Google sync token expired — full resync required");
    this.name = "SyncTokenExpiredError";
  }
}

/**
 * Authorized GET against a Google REST endpoint, returning parsed JSON. A 410
 * surfaces as {@link SyncTokenExpiredError} so the caller can clear its cursor
 * and re-pull from scratch; other non-2xx responses throw with the body.
 */
export async function googleGet<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 410) throw new SyncTokenExpiredError();
  if (!response.ok) {
    throw new Error(
      `Google API ${response.status} for ${url.split("?")[0]}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}
