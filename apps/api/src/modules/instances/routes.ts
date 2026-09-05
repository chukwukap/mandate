import {
  type ChainReader,
  type Hex,
  idSchema,
  Problem,
  pageSchema,
  signatureSchema,
} from "@mandate/contracts";
import { type Repository, type schema, workerAvailable } from "@mandate/database";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { definition, principal, requireAccount, requireEligible, upstream } from "./http.js";
import { decideTransition, guardLifecycle, type LifecycleAction } from "./lifecycle.js";
import { cursorPage, detailView, instanceView } from "./views.js";

/**
 * Narrower than TradingDependencies on purpose — this module needs a repository and exactly two
 * chain reads — but structurally satisfied by it, so app.ts can pass the object it already
 * builds: `registerInstances(app, deps.trading)`. No Config is required; the message a user
 * signs is read from the stored draft, never rebuilt from configuration.
 */
export interface InstancesDependencies {
  repository: Repository;
  chain: Pick<ChainReader, "permissionStatus" | "verifyMessage">;
  /**
   * Worker heartbeat. Optional so `deps.trading` alone is a valid argument; inject a shared
   * reader when several modules should answer from one query per request.
   */
  executionAvailable?: (() => Promise<boolean>) | undefined;
}

type EvaluationRow = typeof schema.evaluations.$inferSelect;
type ExecutionRow = typeof schema.executions.$inferSelect;

const createInput = z.strictObject({
  artifact_id: z.string().regex(/^[0-9a-f]{64}$/),
  signature: signatureSchema,
});
const idParams = z.strictObject({ id: idSchema });

/**
 * Default worker cadence for a new instance, in milliseconds.
 *
 * Carried over unchanged from the route this module replaces; it is also the column default and
 * sits inside the `tick_interval_valid` bound of 1s–1h. Base produces a block every two seconds,
 * so twelve seconds is roughly six blocks: short enough that the price a condition fired on is
 * still current when the worker acts, long enough that a page of instances stays inside the RPC
 * pacing budget in packages/evm.
 */
export const TICK_INTERVAL_MS = 12_000;

function handlers(deps: InstancesDependencies) {
  const { repository: repo, chain } = deps;
  const read = deps.executionAvailable ?? (() => workerAvailable(repo.db));
  /**
   * Advisory UI metadata, resolved once per request and reused across a page.
   *
   * Fails closed: a worker_state read that throws must not fail an otherwise correct response,
   * and `false` is the honest direction — it tells the client not to expect automatic execution.
   * Claiming a live worker we cannot confirm is the one wrong answer here.
   */
  const available = async () => {
    try {
      return await read();
    } catch {
      return false;
    }
  };

  /** Every query below is scoped by this id, and it is only ever the verified principal's. */
  const owner = (request: FastifyRequest) => principal(request).user;

  const list = async (request: FastifyRequest) => {
    const page = pageSchema.parse(request.query);
    const rows = await repo.list(
      owner(request),
      page.limit + 1,
      page.before ? new Date(page.before) : undefined,
      page.before_id,
    );
    const executionAvailable = await available();
    return cursorPage(
      rows,
      page.limit,
      ({ instance }) => ({ before: instance.createdAt.toISOString(), before_id: instance.id }),
      ({ instance, draft }) => instanceView(instance, draft, executionAvailable),
    );
  };

  const detail = async (request: FastifyRequest) => {
    const { id } = idParams.parse(request.params);
    const { instance, draft } = await repo.detail(owner(request), id);
    return detailView(instance, draft, await available());
  };

  const evaluations = async (request: FastifyRequest) => {
    const { id } = idParams.parse(request.params);
    const page = pageSchema.parse(request.query);
    // repo.history calls repo.detail first, so an id owned by somebody else is a 404 here too.
    const rows: (EvaluationRow | ExecutionRow)[] = await repo.history(
      owner(request),
      id,
      "evaluations",
      page.limit + 1,
      page.before ? new Date(page.before) : undefined,
      page.before_id,
    );
    // repo.history is not overloaded, so its return type is the union of both history shapes.
    // `at` exists only on evaluations, and the "evaluations" argument above means nothing else
    // can be in this array.
    const found = rows.filter((row): row is EvaluationRow => "at" in row);
    return cursorPage(
      found,
      page.limit,
      (row) => ({ before: row.at.toISOString(), before_id: row.id }),
      // Rows pass through exactly as stored. apps/web reads id/at/outcome/admitted/refused/
      // notifications/inputs off this shape; reshaping it to snake_case would empty the history
      // panel without erroring anywhere. `userId` is the caller's own id, which /v1/me already
      // returns to them, so echoing it leaks nothing across tenants.
      (row) => row,
    );
  };

  /**
   * Arm additionally requires an active onchain permission when the instance runs automatically.
   *
   * Chain state is the authority, not the stored row: a permission the user revoked directly at
   * the SpendPermissionManager still reads "active" locally until something looks.
   */
  const requireActivePermission = async (user: string, id: string) => {
    const grant = await repo.permission(user, id).catch((error: unknown) => {
      // repo.permission answers 404 for a missing row, which for an instance the caller just
      // fetched would be a flatly misleading "not found". Unreachable while auto mode can only
      // be reached through permission activation, but this is a money path.
      if (error instanceof Problem && error.status === 404)
        throw new Problem(
          409,
          "permission-required",
          "Permission required",
          "Confirm an active onchain spending permission first.",
        );
      throw error;
    });
    const state = await upstream(
      () => chain.permissionStatus(grant.payload),
      "The onchain permission state could not be read. Try again shortly.",
    );
    if (state.revoked || !state.approved)
      throw new Problem(
        409,
        "permission-inactive",
        "Permission inactive",
        "Confirm an active onchain permission before arming.",
      );
  };

  const transition = (action: LifecycleAction) => async (request: FastifyRequest) => {
    const { id } = idParams.parse(request.params);
    const user = owner(request);
    const now = new Date();
    // Order matters: eligibility is checked before the instance is read, so an ineligible caller
    // probing somebody else's id gets the same 403 for every id and learns nothing.
    if (action === "arm") requireEligible(request);
    // The guard writes a lapsed envelope into the row as "ended" under a FOR UPDATE lock, so the
    // status it returns is the whole truth and the table below needs no expiry case of its own.
    const { instance, draft } = await guardLifecycle(repo, user, id, now);
    // Pause and kill are intentionally not gated on the signing wallet. Stopping must stay
    // available to a user who has since unlinked or lost access to it.
    if (action === "arm") requireAccount(request, draft);
    const decision = decideTransition(instance.status, action);
    if (decision instanceof Problem) throw decision;
    if (decision === "apply") {
      if (action === "arm" && instance.mode === "auto") await requireActivePermission(user, id);
      // Repository.transition re-reads FOR UPDATE and re-checks terminal state, expiry and the
      // permission before writing, so a worker tick landing between the guard and this call can
      // only turn an optimistic path into that call's own 409 — never into a bad write.
      await repo.transition(
        user,
        id,
        action,
        now,
        action === "arm" ? request.jurisdiction : undefined,
      );
    }
    const fresh = await repo.detail(user, id);
    return instanceView(fresh.instance, fresh.draft, await available());
  };

  /**
   * Turns a signed draft into a paused instance.
   *
   * The signature is checked against the stored `confirm_message` verbatim. Nothing about the
   * authorization is recomputed here — the artifact the user read and signed is the artifact
   * that runs.
   */
  const create = async (request: FastifyRequest, reply: FastifyReply) => {
    requireEligible(request);
    const input = createInput.parse(request.body);
    const user = principal(request);
    // One instant for the whole request. Reading the clock again below could put the draft's
    // expiry on one side of the deadline for the courtesy check and the other for the claim.
    const now = new Date();
    const draft = await repo.draft(user.user, input.artifact_id);
    if (!draft) throw Problem.notFound();
    requireAccount(request, draft);
    // A courtesy read, not the guarantee: it names the common case ("you already used this")
    // before spending a signature verification on it. The guarantee is in createInstance below,
    // and the two disagree on the code by design — a sequential replay lands here as
    // "draft-expired", a concurrent one lands there as "draft-consumed". Both are 409.
    if (draft.consumedAt || draft.expiresAt.getTime() <= now.getTime())
      throw new Problem(
        409,
        "draft-expired",
        "Draft unavailable",
        "Create and sign a fresh draft.",
      );
    if (
      !(await upstream(
        () =>
          chain.verifyMessage(draft.account as Hex, draft.confirmMessage, input.signature as Hex),
        "The signature could not be verified right now. Try again shortly; do not sign again.",
      ))
    )
      throw new Problem(
        400,
        "invalid-signature",
        "Invalid signature",
        "Sign the exact saved review with its linked wallet.",
      );
    // Consumption is delegated whole: createInstance claims the draft with a single
    // UPDATE ... WHERE consumed_at IS NULL AND expires_at > now, and raises 409 draft-consumed
    // when that matches no row. Deciding it here instead — read, then insert — is exactly the
    // window in which two concurrent submissions of one signature both pass the read and create
    // two instances against one authorization.
    const instance = await repo.createInstance(
      user.user,
      draft,
      input.signature,
      draft.name,
      TICK_INTERVAL_MS,
      now,
    );
    return reply.code(201).send({
      strategy: draft.id,
      version: draft.artifactId,
      instance: instance.id,
      status: instance.status,
      mode: instance.mode,
      // Requesting auto in the draft does not grant anything. Instances always start paused and
      // manual; the client still has to prepare, sign and activate a spending permission.
      needs_permission: draft.mode === "auto",
      execution_available: await available(),
    });
  };

  return { list, detail, evaluations, transition, create };
}

/**
 * Registers everything under /v1/instances: the list, the detail read, the three lifecycle
 * actions and the evaluations feed.
 */
export async function registerInstances(app: FastifyInstance, deps: InstancesDependencies) {
  const route = handlers(deps);

  app.get("/v1/instances", definition("instances", "List owned strategy instances"), route.list);
  app.get(
    "/v1/instances/:id",
    definition("instances", "Get an owned strategy instance", undefined, idParams),
    route.detail,
  );
  for (const action of ["arm", "pause", "kill"] as const)
    app.post(
      `/v1/instances/:id/${action}`,
      definition("instances", `${action} an owned strategy`, undefined, idParams),
      route.transition(action),
    );
  app.get(
    "/v1/instances/:id/evaluations",
    definition("evaluations", "List owned evaluations", undefined, idParams),
    route.evaluations,
  );
}

/**
 * Registers the two /v1/strategies paths that operate on instances: creating one from a signed
 * draft, and the pre-existing list alias.
 *
 * Split from registerInstances so exactly one module owns each path. The strategies module owns
 * POST /v1/strategies/draft; whichever module registers a path, it must be registered once —
 * two registrations of the same method and path is FST_ERR_DUPLICATED_ROUTE at boot, so this is
 * a startup crash, not a degraded response.
 */
export async function registerInstanceAliases(app: FastifyInstance, deps: InstancesDependencies) {
  const route = handlers(deps);

  app.post(
    "/v1/strategies",
    definition("strategies", "Confirm the stored strategy review", createInput),
    route.create,
  );
  // Byte-identical to GET /v1/instances, and kept only because the deployed API answers it.
  // apps/web reads /v1/instances everywhere (features/strategies/use-strategies.ts), so this is
  // a compatibility surface for older clients, not a second contract to maintain.
  app.get("/v1/strategies", definition("strategies", "List owned strategy instances"), route.list);
}
