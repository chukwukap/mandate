import { type Hex, idSchema, Problem, pageSchema } from "@mandate/contracts";
import type { Repository } from "@mandate/database";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { QUOTE_DECIMALS, subtractUsdc, usdc } from "./pricing.js";
import type { ReceiptReader, Settlement } from "./receipts.js";
import { ExecutionQueries, type SummaryRecord } from "./repository.js";
import {
  EXECUTION_STATUSES,
  type ExecutionListItem,
  evaluationReason,
  executionDetail,
  executionListItem,
  outcomeOf,
  splitRefusals,
} from "./view.js";

/**
 * `receipts` is optional and the module is fully functional without it. Unwired, every fill
 * reports `settlement: null` and `fill.state: "unverified"` — which is the truth, because the
 * only durable record of a swap is the slippage floor the worker signed. It must never invent
 * a filled amount to make the page look complete.
 */
export interface ExecutionDependencies {
  repository: Repository;
  receipts?: ReceiptReader | undefined;
  /** Refusal-ledger window. Declared in the response; never presented as lifetime truth. */
  refusalWindowSecs?: number | undefined;
}

const DEFAULT_REFUSAL_WINDOW_SECS = 7 * 86_400;

// Copied from modules/strategies/routes.ts, which does not export them, and matching the copy
// in modules/market/routes.ts. If a shared HTTP module lands under apps/api/src/plugins,
// import from there and delete these two.
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7", io: "input" });
// Signature kept identical to the copies elsewhere, body slot included, even though every
// route here is a GET. A same-named helper with a different argument order is exactly the trap
// that bites when these are finally hoisted into one module.
function definition(tag: string, summary: string, body?: z.ZodType, params?: z.ZodType) {
  return {
    schema: {
      tags: [tag],
      summary,
      security: [{ privy: [] }],
      ...(body ? { body: json(body) } : {}),
      ...(params ? { params: json(params) } : {}),
    },
  };
}
function principal(request: FastifyRequest) {
  if (!request.principal) throw Problem.unauthenticated();
  return request.principal;
}

const idParams = z.strictObject({ id: idSchema });
/**
 * Query filters. Parsed separately from `pageSchema` rather than through `.extend()`, because
 * `pageSchema` carries a `.refine()` and both are non-strict objects, so two parses over the
 * same querystring compose without either rejecting the other's keys.
 */
const filterSchema = z.object({
  instance: idSchema.optional(),
  status: z
    .string()
    .max(200)
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(EXECUTION_STATUSES)).min(1).max(EXECUTION_STATUSES.length))
    .optional(),
});

type Page = { before: string; before_id: string } | null;

function nextPage(rows: { createdAt: Date; id: string }[], limit: number): Page {
  const last = rows.slice(0, limit).at(-1);
  return rows.length > limit && last
    ? { before: last.createdAt.toISOString(), before_id: last.id }
    : null;
}

const CAP_NOTICE =
  "Your caps count every order the strategy admitted, including orders that were later cancelled, reverted or returned to you. Returned funds do not give back cap headroom.";

function summaryView(instance: string, record: SummaryRecord, since: Date, until: Date) {
  const byStatus = new Map(record.totals.map((t) => [t.status, t]));
  const totalOf = (...statuses: string[]) =>
    statuses.reduce((sum, status) => sum + (byStatus.get(status)?.usdcIn ?? 0n), 0n);
  const outcomes: Record<string, number> = {};
  for (const total of record.totals) {
    const { outcome } = outcomeOf(total.status);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + total.orders;
  }
  // Each grouped row contributes its outcome once and each of its refusals once. A tick that
  // refused for two different reasons is therefore counted under both codes, which is why the
  // per-reason figure is labelled "ticks in which this applied" and not a share of the total.
  const outcomeTally = new Map<string, { code: string; message: string; ticks: number }>();
  const reasonTally = new Map<string, { code: string; message: string; ticks: number }>();
  const tally = (
    into: Map<string, { code: string; message: string; ticks: number }>,
    value: string,
    ticks: number,
  ) => {
    const reason = evaluationReason(value);
    const entry = into.get(reason.code) ?? { code: reason.code, message: reason.message, ticks: 0 };
    entry.ticks += ticks;
    into.set(reason.code, entry);
  };
  for (const group of record.evaluations.refusals) {
    tally(outcomeTally, group.outcome, group.ticks);
    for (const refusal of splitRefusals(group.refused)) tally(reasonTally, refusal, group.ticks);
  }
  const ranked = (entries: Map<string, { ticks: number }>) =>
    [...entries.values()].sort((a, b) => b.ticks - a.ticks);
  const admitted = record.runtime.lifetime;
  return {
    instance,
    name: record.instanceName,
    status: record.instanceStatus,
    mode: record.instanceMode,
    orders: {
      total: record.totals.reduce((sum, t) => sum + t.orders, 0),
      by_outcome: outcomes,
      by_status: record.totals.map((total) => ({
        status: total.status,
        outcome: outcomeOf(total.status).outcome,
        orders: total.orders,
        usdc_in: usdc(total.usdcIn),
      })),
      first_at: record.first?.toISOString() ?? null,
      last_at: record.last?.toISOString() ?? null,
    },
    spend: {
      currency: "USDC",
      decimals: QUOTE_DECIMALS,
      /** What the caps have counted. Includes orders that never settled. */
      admitted,
      /** Orders whose swap confirmed onchain. */
      settled: usdc(totalOf("confirmed")),
      /** Input that was sent back to the account. */
      returned: usdc(totalOf("refunded")),
      /** Money committed to an order that is still moving. */
      in_flight: usdc(totalOf("admitted", "pending")),
      /** Notional the strategy signalled but never traded, in manual mode. */
      signalled: usdc(totalOf("signal")),
      /** Orders that stopped without spending: cancelled before funding, or reverted. */
      not_executed: usdc(totalOf("cancelled", "reverted")),
      lifetime_cap: record.envelope.caps.lifetime,
      remaining: subtractUsdc(record.envelope.caps.lifetime, admitted),
      per_period_cap: record.envelope.caps.per_period,
      period_spent: record.runtime.periodSpent,
      cap_notice: CAP_NOTICE,
    },
    refusals: {
      window: {
        since: since.toISOString(),
        until: until.toISOString(),
        secs: Math.round((until.getTime() - since.getTime()) / 1000),
        note: "Evaluations are counted over this window only, not over the strategy's lifetime.",
      },
      ticks: record.evaluations.ticks,
      admitted_orders: record.evaluations.admitted,
      outcomes: ranked(outcomeTally),
      reasons: ranked(reasonTally),
      truncated: record.evaluations.truncated,
    },
  };
}

/**
 * The user's record of what actually happened.
 *
 * Deliberately does NOT declare `GET /v1/instances/:id/executions`: modules/strategies/routes.ts
 * still owns that path, and a second declaration of the same method and path is
 * FST_ERR_DUPLICATED_ROUTE at boot — it would take the whole API down rather than 404 one
 * route. The enriched version ships as `registerInstanceExecutions` and stays uncalled until
 * the duplicate is removed. `/v1/instances/:id/executions/summary` is a distinct static child
 * segment and coexists with the existing route safely.
 */
export async function registerExecutions(app: FastifyInstance, deps: ExecutionDependencies) {
  const queries = new ExecutionQueries(deps.repository);
  const windowSecs = deps.refusalWindowSecs ?? DEFAULT_REFUSAL_WINDOW_SECS;

  app.get("/v1/executions", definition("executions", "List owned executions"), async (request) => {
    const user = principal(request).user;
    const page = pageSchema.parse(request.query);
    const filter = filterSchema.parse(request.query);
    // An instance filter is checked for ownership rather than left to RLS to empty out. A
    // silent empty page for someone else's id reads as "your strategy never traded".
    if (filter.instance) await deps.repository.detail(user, filter.instance);
    const rows = await queries.list(user, {
      instance: filter.instance,
      statuses: filter.status,
      limit: page.limit + 1,
      before: page.before ? new Date(page.before) : undefined,
      beforeId: page.before_id,
    });
    return {
      items: rows
        .slice(0, page.limit)
        .map((row) => executionListItem(row.execution, row.envelope, row.strategyName)),
      next_page: nextPage(
        rows.map((row) => row.execution),
        page.limit,
      ),
    };
  });

  app.get(
    "/v1/executions/:id",
    {
      ...definition(
        "executions",
        "Get one execution with its settlement detail",
        undefined,
        idParams,
      ),
      // This is the only route in the module that touches the chain. Its own tighter limit
      // stops a client that refreshes a detail page from turning the API into an RPC
      // amplifier against a public endpoint the docs already describe as paced.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const user = principal(request).user;
      const { id } = idParams.parse(request.params);
      const record = await queries.detail(user, id);
      const settlements = new Map<string, Settlement | null>();
      const reader = deps.receipts;
      if (reader) {
        // At most five reads: `unique("execution_leg")` allows one row per leg and there are
        // five legs. Each is cached and de-duplicated inside the reader.
        const settled = record.journal.filter((entry) => entry.status !== "signed");
        const results = await Promise.all(
          settled.map((entry) =>
            reader
              .settlement({
                hash: entry.hash as Hex,
                expect: entry.evidence
                  ? { token: entry.evidence.token, recipient: entry.evidence.recipient }
                  : undefined,
              })
              // The reader's own contract is to return null rather than throw, but a route
              // that renders durable history must not 500 because an injected reader broke
              // that contract.
              .catch(() => null),
          ),
        );
        for (const [index, entry] of settled.entries())
          settlements.set(entry.hash, results[index] ?? null);
      }
      return executionDetail({
        row: record.execution,
        envelope: record.envelope,
        strategyName: record.strategyName,
        account: record.account,
        journal: record.journal,
        settlements,
        evaluation: record.evaluation,
        receiptsEnabled: Boolean(reader),
      });
    },
  );

  app.get(
    "/v1/instances/:id/executions/summary",
    definition("executions", "Summarise one strategy's orders and refusals", undefined, idParams),
    async (request) => {
      const user = principal(request).user;
      const { id } = idParams.parse(request.params);
      const until = new Date();
      const since = new Date(until.getTime() - windowSecs * 1000);
      return summaryView(id, await queries.summary(user, id, since), since, until);
    },
  );
}

/**
 * The enriched replacement for `GET /v1/instances/:id/executions`.
 *
 * Exported but never called by `registerExecutions`. Wire it only after the `executions` half
 * of the `for (const kind of ["evaluations", "executions"])` loop in
 * modules/strategies/routes.ts is removed; registering both is a boot failure.
 *
 * Response shape is a superset of what that route returns today, so apps/web keeps working
 * across the swap — see the compatibility block on `ExecutionListItem`.
 */
export async function registerInstanceExecutions(
  app: FastifyInstance,
  deps: ExecutionDependencies,
) {
  const queries = new ExecutionQueries(deps.repository);
  app.get(
    "/v1/instances/:id/executions",
    definition("executions", "List owned executions for one strategy", undefined, idParams),
    async (request) => {
      const user = principal(request).user;
      const { id } = idParams.parse(request.params);
      const page = pageSchema.parse(request.query);
      const filter = filterSchema.parse(request.query);
      // 404 for an instance that is not the caller's, matching Repository.history.
      await deps.repository.detail(user, id);
      const rows = await queries.list(user, {
        instance: id,
        statuses: filter.status,
        limit: page.limit + 1,
        before: page.before ? new Date(page.before) : undefined,
        beforeId: page.before_id,
      });
      const items: ExecutionListItem[] = rows
        .slice(0, page.limit)
        .map((row) => executionListItem(row.execution, row.envelope, row.strategyName));
      return {
        items,
        next_page: nextPage(
          rows.map((row) => row.execution),
          page.limit,
        ),
      };
    },
  );
}
