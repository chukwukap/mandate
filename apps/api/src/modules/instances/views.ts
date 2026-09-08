import type { DraftRow, InstanceRow } from "@mandate/database";

/** The two fields a client must echo back to fetch the following page. Both, or neither. */
export type Cursor = { before: string; before_id: string };
export type Page<Item> = { items: Item[]; next_page: Cursor | null };

/**
 * The summary object every list row and every lifecycle response returns.
 *
 * Field-for-field what apps/web/src/features/strategies/types.ts reads, including the two names
 * that do not match their column: `strategy` is the draft id (the signed artifact the instance
 * runs) and `spent` is runtime.lifetime (spent-to-date), against `lifetime` (the signed cap).
 * Renaming either would silently blank the budget meter.
 *
 * Every amount stays exactly as stored: decimal strings for money, an integer for the order
 * count. Nothing here goes through Number() — 100.000001 USDC is representable as a string and
 * is not representable as a float, and this value is shown to a user as their spend.
 *
 * `execution_available` is passed in rather than read here so one worker_state query serves a
 * whole page. Resolving it per row turned `?limit=100` into 100 identical SELECTs.
 */
export function instanceView(instance: InstanceRow, draft: DraftRow, executionAvailable: boolean) {
  return {
    id: instance.id,
    strategy: draft.id,
    name: instance.name,
    mode: instance.mode,
    requested_mode: draft.mode,
    status: instance.status,
    halt_reason: instance.haltReason,
    last_tick_at: instance.lastTickAt,
    next_tick_at: instance.nextTickAt,
    spent: instance.runtime.lifetime,
    lifetime: draft.envelope.caps.lifetime,
    orders: instance.runtime.totalOrders,
    created_at: instance.createdAt,
    execution_available: executionAvailable,
    // The symbols only, not the whole envelope: a list row needs to say WHICH stocks a strategy
    // watches — a seven-name basket and a single-stock ladder were otherwise indistinguishable
    // in the list — while the addresses, decimals and feeds belong to the detail view. The draft
    // is already loaded for the caps above, so this costs no extra query.
    assets: draft.envelope.assets.map((asset) => asset.symbol),
    // Set by `arm` and read by the worker: an armed instance whose attestation has lapsed is
    // paused with failure "eligibility-renewal-required" rather than traded.
    eligibility_expires_at: instance.eligibilityExpiresAt,
  };
}

/**
 * The summary plus the signed authority itself.
 *
 * `plan`, `envelope`, `render_text` and `render_sha256` are the exact artifact the user signed,
 * returned verbatim from the draft row so a client can re-display — or re-hash — what was
 * authorized. They are never recomputed here: a rebuilt render would hash differently from the
 * one the signature covers.
 */
export function detailView(instance: InstanceRow, draft: DraftRow, executionAvailable: boolean) {
  return {
    ...instanceView(instance, draft, executionAvailable),
    account: draft.account,
    plan: draft.plan,
    envelope: draft.envelope,
    render_text: draft.renderText,
    render_sha256: draft.renderHash,
  };
}

/**
 * Shapes a keyset page that was fetched with `limit + 1` rows.
 *
 * The extra row is the only reliable "is there more" signal: counting is a second query against
 * a moving table, and `rows.length === limit` is wrong exactly at the boundary, which is where
 * an infinite scroll stops one page early.
 *
 * The cursor is taken from the last row *returned to the client*, never from the probe row, and
 * always carries both halves. Timestamp alone is not a key — instances created inside the same
 * millisecond share a `created_at`, and a timestamp-only cursor either loses one of them or
 * loops forever on it. Both list queries order by (timestamp desc, id desc) to match.
 */
export function cursorPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  cursorOf: (row: Row) => Cursor,
  map: (row: Row) => Item,
): Page<Item> {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(map),
    next_page: rows.length > limit && last ? cursorOf(last) : null,
  };
}
