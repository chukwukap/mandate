import { randomUUID } from "node:crypto";
import { selectWallet } from "@mandate/auth";
import type { Config } from "@mandate/config";
import {
  type Asset,
  type ChainReader,
  idSchema,
  modeSchema,
  Problem,
  signatureSchema,
} from "@mandate/contracts";
import {
  type DraftRow,
  type InstanceRow,
  type Repository,
  workerAvailable,
} from "@mandate/database";
import { CHAIN_ID, USDC } from "@mandate/evm";
import {
  authorizationMessage,
  ClarificationRequired,
  type Compiler,
  capsSchema,
  digest,
  type Envelope,
  planSchema,
  review,
  validatePlan,
} from "@mandate/strategy";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

export interface TradingDependencies {
  repository: Repository;
  chain: ChainReader;
  assets: readonly Asset[];
  compiler?: Compiler | undefined;
}
const draftInput = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    prompt: z.string().trim().min(1).max(4000).optional(),
    plan: planSchema.optional(),
    caps: capsSchema,
    assets: z.array(z.string().min(1).max(24)).min(1).max(20),
    mode: modeSchema.default("manual"),
  })
  .refine((v) => Boolean(v.prompt) !== Boolean(v.plan), "Provide either prompt or plan");
const _createInput = z.strictObject({
  artifact_id: z.string().regex(/^[0-9a-f]{64}$/),
  signature: signatureSchema,
});
const _idParams = z.strictObject({ id: idSchema });
const _quoteInput = z.strictObject({
  symbol: z.string().max(24),
  side: z.enum(["buy", "sell"]),
  amount: z.string().regex(/^\d{1,30}(\.\d{1,18})?$/),
  slippage_bps: z.int().min(1).max(500).default(50),
});
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7", io: "input" });
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
function wallet(request: FastifyRequest) {
  const header = request.headers["x-mandate-wallet"];
  return selectWallet(principal(request), typeof header === "string" ? header : undefined);
}
function requireEligible(request: FastifyRequest) {
  if (!request.eligible)
    throw new Problem(
      403,
      "not-eligible",
      "Trading unavailable",
      "Trading is unavailable for your verified jurisdiction.",
    );
}
function _requireAccount(request: FastifyRequest, draft: DraftRow) {
  if (wallet(request) !== draft.account)
    throw new Problem(
      403,
      "account-mismatch",
      "Choose the signing wallet",
      "Select the linked wallet used to sign this strategy.",
    );
}
function _instanceView(instance: InstanceRow, draft: DraftRow) {
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
    execution_available: false,
  };
}

export async function registerTrading(
  app: FastifyInstance,
  config: Config,
  deps: TradingDependencies,
) {
  const { repository: repo } = deps;
  const available = () => workerAvailable(repo.db);

  // Only the authoring route lives here now. Market, instances, automation and executions
  // moved to their own modules; /v1/strategies POST and GET are registered by
  // registerInstanceAliases. Registering a path twice is FST_ERR_DUPLICATED_ROUTE at boot,
  // so each path must have exactly one owner.
  app.post(
    "/v1/strategies/draft",
    {
      ...definition("strategies", "Create an immutable strategy review", draftInput),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      requireEligible(request);
      const user = principal(request);
      const account = wallet(request);
      const input = draftInput.parse(request.body);
      const now = new Date();
      if (
        Date.parse(input.caps.expires_at) <= now.getTime() + 60_000 ||
        Date.parse(input.caps.expires_at) > now.getTime() + 366 * 86400_000
      )
        throw new Problem(
          400,
          "invalid-expiry",
          "Invalid expiry",
          "Choose an expiry more than one minute and no more than one year away.",
        );
      if (new Set(input.assets).size !== input.assets.length)
        throw new Problem(
          400,
          "duplicate-asset",
          "Duplicate asset",
          "Each asset may be listed once.",
        );
      const assets = input.assets.map((symbol) => {
        const asset = deps.assets.find((a) => a.symbol === symbol);
        if (!asset)
          throw new Problem(
            400,
            "unknown-asset",
            "Unknown asset",
            `Unsupported catalogue symbol: ${symbol}`,
          );
        return asset;
      });
      let proposal: { name: string; reading: string; plan: unknown };
      if (input.prompt) {
        if (!deps.compiler)
          throw Problem.unavailable(
            "Strategy text authoring requires a configured compiler. Structured plans remain available.",
          );
        try {
          proposal = await deps.compiler.compile(input.prompt, assets);
        } catch (error) {
          if (error instanceof ClarificationRequired)
            throw new Problem(422, "clarification-required", "More detail needed", error.message);
          throw Problem.unavailable(
            "The strategy compiler could not complete the request. Try again shortly.",
          );
        }
      } else
        proposal = {
          name: input.name ?? "Untitled strategy",
          reading: "Structured plan supplied by the user.",
          plan: input.plan,
        };
      let plan: ReturnType<typeof validatePlan>;
      try {
        plan = validatePlan(proposal.plan, assets);
      } catch (error) {
        throw new Problem(
          400,
          "invalid-plan",
          "Invalid strategy",
          error instanceof Error ? error.message : "Invalid plan",
        );
      }
      const envelope: Envelope = {
        version: "mandate/2",
        caps: input.caps,
        assets,
        quote: USDC,
        venue: "aerodrome",
      };
      let rendered: ReturnType<typeof review>;
      try {
        rendered = review(plan, envelope);
      } catch {
        throw new Problem(
          400,
          "review-too-complex",
          "Simplify the strategy",
          "The strategy is too complex to render for review.",
        );
      }
      const id = randomUUID();
      const name = input.name ?? proposal.name;
      const expiresAt = new Date(
        Math.min(now.getTime() + 30 * 60_000, Date.parse(input.caps.expires_at)),
      );
      const artifactId = digest({
        id,
        user: user.user,
        account,
        name,
        mode: input.mode,
        plan,
        envelope,
        render: rendered.render_text,
        expires: expiresAt.toISOString(),
      });
      // Built by @mandate/strategy, not by hand. Signature verification compares this string
      // byte for byte against the one the worker reconstructs, so a single space added on one
      // side would make every strategy fail admission. One definition makes that impossible.
      const confirmMessage = authorizationMessage({
        origin: config.origin,
        chainId: CHAIN_ID,
        account,
        artifact: artifactId,
        name,
        mode: input.mode,
        expires: expiresAt.toISOString(),
        render: rendered.render_text,
      });
      await repo.saveDraft({
        id,
        userId: user.user,
        account,
        artifactId,
        name,
        mode: input.mode,
        plan,
        envelope,
        reading: proposal.reading,
        renderText: rendered.render_text,
        renderHash: rendered.render_sha256,
        confirmMessage,
        createdAt: now,
        expiresAt,
      });
      return reply.code(201).send({
        artifact_id: artifactId,
        plan,
        envelope,
        name,
        reading: proposal.reading,
        ...rendered,
        confirm_message: confirmMessage,
        expires_at: expiresAt.toISOString(),
        execution_available: await available(),
      });
    },
  );
}
