import type { Config } from "@mandate/config";
import { type ChainReader, type Hex, idSchema, Problem, signatureSchema } from "@mandate/contracts";
import { type PermissionRow, type Repository, workerAvailable } from "@mandate/database";
import { approvalCall, revocationCall } from "@mandate/evm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { definition, principal, requireAccount, requireEligible, upstream } from "./guards.js";
import {
  buildPermissionRow,
  permissionEnd,
  permissionView,
  requiresSellAuthority,
} from "./permission.js";

/**
 * Deliberately a structural subset of TradingDependencies, so app.ts can wire this module with
 * the object it already builds: `registerPermissions(app, config, deps.trading)`.
 */
export interface PermissionsDependencies {
  repository: Repository;
  chain: ChainReader;
}

const instanceInput = z.strictObject({ instance: idSchema });
const grantInput = instanceInput.extend({ signature: signatureSchema });
const activateInput = z.strictObject({ enable_auto: z.boolean().default(false) });
const idParams = z.strictObject({ id: idSchema });

export async function registerPermissions(
  app: FastifyInstance,
  config: Config,
  deps: PermissionsDependencies,
) {
  const { repository: repo, chain } = deps;
  // Advisory UI metadata. A worker_state read failure must not fail an otherwise successful
  // permission response, and `false` is the safe direction: it tells the client not to expect
  // automatic execution.
  const available = async () => {
    try {
      return await workerAvailable(repo.db);
    } catch {
      return false;
    }
  };
  const prepared = async (row: PermissionRow) => ({
    ...permissionView(row),
    execution_available: await available(),
  });

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
      if (requiresSellAuthority(draft.plan))
        throw new Problem(
          409,
          "sell-permission-required",
          "Automatic sell authority unavailable",
          "Automatic sell strategies require per-asset spending authority. Use manual mode until that execution capability is available.",
        );
      if (
        (await upstream(
          () => chain.walletKind(draft.account as Hex),
          "The account's wallet capabilities could not be read. Try again shortly.",
        )) !== "base_account"
      )
        throw new Problem(
          409,
          "wallet-unsupported",
          "Wallet permission unsupported",
          "This account must support Coinbase SpendPermissionManager before it can authorize automatic execution.",
        );
      // One `now` for the whole request. It reaches the payload only through
      // buildPermissionRow, and only on the insert path inside preparePermission's lock; a
      // second call returns the stored row untouched, so `start` never moves.
      const now = new Date();
      // Pre-flight before taking the instance row lock, and before any row is written: an
      // already-expired strategy is a 409, not a permission nobody can use.
      if (permissionEnd(draft.envelope.caps.expires_at) <= Math.floor(now.getTime() / 1000))
        throw new Problem(409, "expired", "Strategy expired", "Create a fresh strategy.");
      const row = await repo.preparePermission(user, instance, () =>
        buildPermissionRow({
          user,
          instance,
          draft,
          spender: config.spenderAddress as Hex,
          now,
        }),
      );
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
      // Reloaded, never rebuilt. This row is what the user's wallet hashed; rebuilding it here
      // is the digest bug the Rust original shipped.
      const row = await repo.permission(user, input.instance);
      if (
        !(await upstream(
          () => chain.verifyPermission(row.payload, input.signature as Hex),
          "The signature could not be verified onchain right now. Try again shortly; do not sign again.",
        ))
      )
        throw new Problem(
          400,
          "invalid-signature",
          "Invalid signature",
          "Sign the stored spending-permission payload.",
        );
      const saved = await repo.saveGrant(user, row, input.signature, new Date());
      return {
        ...(await prepared(saved)),
        // Explicit, because permissionView only attaches approval_call while status is
        // "signed": an idempotent re-submit of an already-active permission still needs the
        // call available to a client that lost its transaction receipt.
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
      // Only observed chain state may promote a permission to "active". A signature stored
      // locally is not authority; the approval transaction is.
      const status = await upstream(
        () => chain.permissionStatus(row.payload),
        "The onchain permission state could not be read. Try again shortly.",
      );
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
      // Withdrawing onchain authority is deliberately NOT gated on requireEligible or
      // requireAccount. A user whose jurisdiction stopped being eligible, or who has two linked
      // wallets and omitted X-Mandate-Wallet, must still be able to stop the spender. Ownership
      // is still enforced: repo.permission(user, id) runs under RLS. Making this "consistent"
      // with the other routes would strand users behind a live permission.
      const row = await repo.permission(user, id);
      const { instance } = await repo.detail(user, id);
      // Pause first, read the chain second. If the RPC is down the request fails 503 with the
      // instance already paused — the fail-safe direction — and the endpoint stays idempotent
      // on retry.
      if (!["halted", "ended"].includes(instance.status))
        await repo.transition(user, id, "pause", new Date());
      const status = await upstream(
        () => chain.permissionStatus(row.payload),
        "The onchain permission state could not be read. The strategy is paused; retry to confirm revocation.",
      );
      if (status.revoked)
        return {
          ...(await prepared(
            await repo.setPermissionStatus(user, row, "revoked", new Date(), false),
          )),
          onchain_revocation_required: false,
        };
      const call = revocationCall(row.payload);
      return {
        ...(await prepared(row)),
        // `revocation_call` is the name apps/web reads and the name docs/api/README.md uses.
        // `revoke_call` is the name this endpoint has been emitting; kept as a deprecated alias
        // so no existing client breaks. Emitting only `revoke_call` silently disabled the web
        // revoke button — it paused the instance and never broadcast the revocation, leaving a
        // live onchain permission behind a UI that claimed otherwise.
        revocation_call: call,
        revoke_call: call,
        account: row.payload.account,
        onchain_revocation_required: true,
      };
    },
  );
}
