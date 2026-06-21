/** Sentinel thrown when Google reports a sync token expired (HTTP 410 GONE). */
export class SyncTokenExpiredError extends Error {
  constructor() {
    super("Google sync token expired — full resync required");
    this.name = "SyncTokenExpiredError";
  }
}

/** Build an Error mirroring a non-2xx Google response, with the path and body. */
async function googleApiError(url: string, response: Response): Promise<Error> {
  return new Error(
    `Google API ${response.status} for ${url.split("?")[0]}: ${await response.text()}`,
  );
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
  if (!response.ok) throw await googleApiError(url, response);
  return (await response.json()) as T;
}

/**
 * Authorized write (POST/PATCH/PUT) against a Google REST endpoint, returning the
 * parsed JSON body. Used by the Tasks connector's create/complete paths — the
 * first connector capability that writes back to the user's Google data. Non-2xx
 * responses throw with the body so the route can surface a meaningful error.
 */
export async function googleWrite<T>(
  url: string,
  accessToken: string,
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await googleApiError(url, response);
  return (await response.json()) as T;
}
