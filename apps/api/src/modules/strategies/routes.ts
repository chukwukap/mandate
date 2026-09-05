import { randomBytes, randomUUID } from "node:crypto";
import { selectWallet } from "@mandate/auth";
import type { Config } from "@mandate/config";
import {
  type Asset,
  type ChainReader,
  type Hex,
  idSchema,
  modeSchema,
  Problem,
  pageSchema,
  signatureSchema,
} from "@mandate/contracts";
import {
  type DraftRow,
  type InstanceRow,
  type PermissionRow,
  type Repository,
  workerAvailable,
} from "@mandate/database";
import {
  approvalCall,
  CHAIN_ID,
  permissionHash,
  permissionJson,
  revocationCall,
  USDC,
} from "@mandate/evm";
import {
  ClarificationRequired,
  type Compiler,
  capsSchema,
  digest,
  type Envelope,
  planSchema,
  review,
  units,
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
const createInput = z.strictObject({
  artifact_id: z.string().regex(/^[0-9a-f]{64}$/),
  signature: signatureSchema,
});
const instanceInput = z.strictObject({ instance: idSchema });
const grantInput = instanceInput.extend({ signature: signatureSchema });
const activateInput = z.strictObject({ enable_auto: z.boolean().default(false) });
const idParams = z.strictObject({ id: idSchema });
const quoteInput = z.strictObject({
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
function requireAccount(request: FastifyRequest, draft: DraftRow) {
  if (wallet(request) !== draft.account)
    throw new Problem(
      403,
      "account-mismatch",
      "Choose the signing wallet",
      "Select the linked wallet used to sign this strategy.",
    );
}
function instanceView(instance: InstanceRow, draft: DraftRow) {
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
function permissionView(row: PermissionRow) {
  return {
    id: row.id,
    instance: row.instanceId,
    status: row.status,
    typed_data: permissionJson(row.payload),
    hash: row.hash,
    spender: row.payload.spender,
    allowance: row.payload.allowance,
    token: row.payload.token,
    period_secs: row.payload.period,
    expires_at: new Date(row.payload.end * 1000).toISOString(),
    execution_available: false,
    ...(row.signature && row.status === "signed"
      ? { approval_call: approvalCall(row.payload, row.signature as Hex) }
      : {}),
  };
}

export async function registerTrading(
  app: FastifyInstance,
  config: Config,
  deps: TradingDependencies,
) {
  const { repository: repo, chain } = deps;
  const available = () => workerAvailable(repo.db);
  const view = async (instance: InstanceRow, draft: DraftRow) => ({
    ...instanceView(instance, draft),
    execution_available: await available(),
    eligibility_expires_at: instance.eligibilityExpiresAt,
  });
  const prepared = async (row: PermissionRow) => ({
    ...permissionView(row),
    execution_available: await available(),
  });
  app.get(
    "/v1/market",
    { schema: { tags: ["market"], summary: "Catalogue and observed market feeds" } },
    async () => ({
      chain_id: CHAIN_ID,
      assets: deps.assets,
      feeds: await chain.market(),
      execution_available: await available(),
      reference_notice:
        "Reference feeds can hold the last close during closed sessions or corporate-action pauses. A quote is not a trade authorization.",
    }),
  );
  app.post(
    "/v1/market/quote",
    definition("market", "Read-only exact-input quote", quoteInput),
    async (request) => {
      requireEligible(request);
      const input = quoteInput.parse(request.body);
      const asset = deps.assets.find((a) => a.symbol === input.symbol);
      if (!asset)
        throw new Problem(
          400,
          "unknown-asset",
          "Unknown asset",
          "Choose an asset from the catalogue.",
        );
      return chain.quote(asset, input.side, input.amount, input.slippage_bps);
    },
  );
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
      const confirmMessage = `Mandate strategy authorization\nOrigin: ${config.origin}\nChain: ${CHAIN_ID}\nAccount: ${account}\nArtifact: ${artifactId}\nName: ${name}\nRequested mode: ${input.mode}\nSign before: ${expiresAt.toISOString()}\n\n${rendered.render_text}`;
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
  app.post(
    "/v1/strategies",
    definition("strategies", "Confirm the stored strategy review", createInput),
    async (request, reply) => {
      requireEligible(request);
      const input = createInput.parse(request.body);
      const user = principal(request);
      const draft = await repo.draft(user.user, input.artifact_id);
      if (!draft) throw Problem.notFound();
      requireAccount(request, draft);
      if (draft.consumedAt || draft.expiresAt.getTime() <= Date.now())
        throw new Problem(
          409,
          "draft-expired",
          "Draft unavailable",
          "Create and sign a fresh draft.",
        );
      if (
        !(await chain.verifyMessage(
          draft.account as Hex,
          draft.confirmMessage,
          input.signature as Hex,
        ))
      )
        throw new Problem(
          400,
          "invalid-signature",
          "Invalid signature",
          "Sign the exact saved review with its linked wallet.",
        );
      const instance = await repo.createInstance(
        user.user,
        draft,
        input.signature,
        draft.name,
        12000,
        new Date(),
      );
      return reply.code(201).send({
        strategy: draft.id,
        version: draft.artifactId,
        instance: instance.id,
        status: instance.status,
        mode: instance.mode,
        needs_permission: draft.mode === "auto",
        execution_available: await available(),
      });
    },
  );
  for (const path of ["/v1/strategies", "/v1/instances"])
    app.get(path, definition("strategies", "List owned strategy instances"), async (request) => {
      const page = pageSchema.parse(request.query);
      const rows = await repo.list(
        principal(request).user,
        page.limit + 1,
        page.before ? new Date(page.before) : undefined,
        page.before_id,
      );
      const selected = rows.slice(0, page.limit);
      const last = selected.at(-1)?.instance;
      return {
        items: await Promise.all(selected.map(({ instance, draft }) => view(instance, draft))),
        next_page:
          rows.length > page.limit && last
            ? { before: last.createdAt.toISOString(), before_id: last.id }
            : null,
      };
    });
  app.get(
    "/v1/instances/:id",
    definition("instances", "Get an owned strategy instance", undefined, idParams),
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { instance, draft } = await repo.detail(principal(request).user, id);
      return {
        ...(await view(instance, draft)),
        account: draft.account,
        plan: draft.plan,
        envelope: draft.envelope,
        render_text: draft.renderText,
        render_sha256: draft.renderHash,
      };
    },
  );
  for (const action of ["arm", "pause", "kill"] as const)
    app.post(
      `/v1/instances/:id/${action}`,
      definition("instances", `${action} an owned strategy`, undefined, idParams),
      async (request) => {
        const { id } = idParams.parse(request.params);
        const user = principal(request).user;
        if (action === "arm") {
          requireEligible(request);
          const { draft, instance } = await repo.detail(user, id);
          requireAccount(request, draft);
          if (instance.mode === "auto") {
            const grant = await repo.permission(user, id);
            const state = await chain.permissionStatus(grant.payload);
            if (state.revoked || !state.approved)
              throw new Problem(
                409,
                "permission-inactive",
                "Permission inactive",
                "Confirm an active onchain permission before arming.",
              );
          }
        }
        await repo.transition(
          user,
          id,
          action,
          new Date(),
          action === "arm" ? request.jurisdiction : undefined,
        );
        const { instance, draft } = await repo.detail(user, id);
        return view(instance, draft);
      },
    );
  for (const kind of ["evaluations", "executions"] as const)
    app.get(
      `/v1/instances/:id/${kind}`,
      definition(kind, `List owned ${kind}`, undefined, idParams),
      async (request) => {
        const { id } = idParams.parse(request.params);
        const page = pageSchema.parse(request.query);
        const rows = await repo.history(
          principal(request).user,
          id,
          kind,
          page.limit + 1,
          page.before ? new Date(page.before) : undefined,
          page.before_id,
        );
        const selected = rows.slice(0, page.limit);
        const last = selected.at(-1);
        return {
          items: selected,
          next_page:
            rows.length > page.limit && last
              ? {
                  before: ("at" in last ? last.at : last.createdAt).toISOString(),
                  before_id: last.id,
                }
              : null,
        };
      },
    );
  app.post(
    "/v1/permissions/prepare",
    definition("permissions", "Prepare a stable spending-permission payload", instanceInput),
    async (request) => {
      requireEligible(request);
      const { instance } = instanceInput.parse(request.body);
      const user = principal(request).user;
      const { draft } = await repo.detail(user, instance);
      requireAccount(request, draft);
      if (!config.spenderAddress)
        throw Problem.unavailable("A worker spender address has not been configured.");
      if (draft.mode !== "auto")
        throw new Problem(
          409,
          "manual-strategy",
          "Manual strategy",
          "Create a new signed draft in automatic mode first.",
        );
      if (
        draft.plan.machines.some((m) =>
          m.states.some((s) =>
            s.transitions.some((t) =>
              t.actions.some((a) => a.action === "order" && a.side === "sell"),
            ),
          ),
        )
      )
        throw new Problem(
          409,
          "sell-permission-required",
          "Automatic sell authority unavailable",
          "Automatic sell strategies require per-asset spending authority. Use manual mode until that execution capability is available.",
        );
      if ((await chain.walletKind(draft.account as Hex)) !== "base_account")
        throw new Problem(
          409,
          "wallet-unsupported",
          "Wallet permission unsupported",
          "This account must support Coinbase SpendPermissionManager before it can authorize automatic execution.",
        );
      const now = new Date();
      const end = Math.floor(Date.parse(draft.envelope.caps.expires_at) / 1000);
      if (end <= Math.floor(now.getTime() / 1000))
        throw new Problem(409, "expired", "Strategy expired", "Create a fresh strategy.");
      const row = await repo.preparePermission(user, instance, () => {
        const payload = {
          account: draft.account as Hex,
          spender: config.spenderAddress as Hex,
          token: USDC,
          allowance: units(draft.envelope.caps.per_period, 6).toString(),
          period: draft.envelope.caps.period_secs,
          start: Math.floor(now.getTime() / 1000),
          end,
          salt: BigInt(`0x${randomBytes(32).toString("hex")}`).toString(),
          extraData: "0x" as Hex,
        };
        return {
          id: randomUUID(),
          userId: user,
          instanceId: instance,
          token: USDC.toLowerCase(),
          payload,
          hash: permissionHash(payload),
          createdAt: now,
          updatedAt: now,
        };
      });
      return prepared(row);
    },
  );
  app.post(
    "/v1/permissions",
    definition("permissions", "Verify and save a signed spending permission", grantInput),
    async (request) => {
      requireEligible(request);
      const input = grantInput.parse(request.body);
      const user = principal(request).user;
      const { draft } = await repo.detail(user, input.instance);
      requireAccount(request, draft);
      const row = await repo.permission(user, input.instance);
      if (!(await chain.verifyPermission(row.payload, input.signature as Hex)))
        throw new Problem(
          400,
          "invalid-signature",
          "Invalid signature",
          "Sign the stored spending-permission payload.",
        );
      const saved = await repo.saveGrant(user, row, input.signature, new Date());
      return {
        ...(await prepared(saved)),
        approval_call: approvalCall(row.payload, input.signature as Hex),
        onchain_approval_required: saved.status !== "active",
      };
    },
  );
  app.get(
    "/v1/instances/:id/permission",
    definition("permissions", "Read the stored spending permission", undefined, idParams),
    async (request) =>
      prepared(await repo.permission(principal(request).user, idParams.parse(request.params).id)),
  );
  app.post(
    "/v1/instances/:id/permission/activate",
    definition(
      "permissions",
      "Verify onchain approval before enabling automatic mode",
      activateInput,
      idParams,
    ),
    async (request) => {
      requireEligible(request);
      const { id } = idParams.parse(request.params);
      const input = activateInput.parse(request.body);
      const user = principal(request).user;
      const { draft } = await repo.detail(user, id);
      requireAccount(request, draft);
      const row = await repo.permission(user, id);
      const now = new Date();
      const status = await chain.permissionStatus(row.payload);
      if (status.revoked || row.payload.end * 1000 <= now.getTime())
        return prepared(
          await repo.setPermissionStatus(
            user,
            row,
            status.revoked ? "revoked" : "expired",
            now,
            false,
          ),
        );
      if (!status.approved)
        throw new Problem(
          409,
          "approval-pending",
          "Onchain approval pending",
          "Submit the approval call and wait for confirmation first.",
        );
      return prepared(await repo.setPermissionStatus(user, row, "active", now, input.enable_auto));
    },
  );
  app.post(
    "/v1/instances/:id/permission/revoke",
    definition("permissions", "Pause locally and prepare onchain revocation", undefined, idParams),
    async (request) => {
      const { id } = idParams.parse(request.params);
      const user = principal(request).user;
      const row = await repo.permission(user, id);
      const { instance } = await repo.detail(user, id);
      if (!["halted", "ended"].includes(instance.status))
        await repo.transition(user, id, "pause", new Date());
      const status = await chain.permissionStatus(row.payload);
      if (status.revoked)
        return {
          ...(await prepared(
            await repo.setPermissionStatus(user, row, "revoked", new Date(), false),
          )),
          onchain_revocation_required: false,
        };
      return {
        ...(await prepared(row)),
        revoke_call: revocationCall(row.payload),
        account: row.payload.account,
        onchain_revocation_required: true,
      };
    },
  );
}
