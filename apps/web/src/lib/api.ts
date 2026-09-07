export type Page<T> = { items: T[]; next_page: { before: string; before_id: string } | null };
export async function request<T>(
  path: string,
  options: {
    token?: string | null;
    wallet?: string | null;
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.wallet) headers.set("X-Mandate-Wallet", options.wallet);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/mandate${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    cache: "no-store",
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    // The Problem's own `code` travels with the error. Without it every failure looks the same
    // to a caller, and some of them are not failures: a 422 `clarification-required` is the
    // strategy compiler asking a question, which belongs on screen as a prompt to add detail
    // rather than as a red banner saying something went wrong.
    throw new ApiError(
      value?.detail ?? "Couldn't reach Mandate. Please try again.",
      value?.code,
      response.status,
    );
  }
  return value as T;
}

/** An error that remembers which Problem it came from. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiCall = <T>(path: string, body?: unknown) => Promise<T>;
