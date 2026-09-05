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
  if (!response.ok) throw new Error(value?.detail ?? "Couldn't reach Mandate. Please try again.");
  return value as T;
}

export type ApiCall = <T>(path: string, body?: unknown) => Promise<T>;
