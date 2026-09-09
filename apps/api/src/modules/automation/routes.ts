import { selectWallet } from "@mandate/auth";
import type { Config } from "@mandate/config";
import { addressSchema, type Hex, Problem } from "@mandate/contracts";
import type { DraftRow, InstanceRow, Repository } from "@mandate/database";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { TERMINAL } from "../instances/lifecycle.js";
import { automationUnsupported, delegation, type WalletReader } from "./delegation.js";

export interface AutomationDependencies {
  repository: Repository;
  wallets: WalletReader;
}

const toggleInput = z.strictObject({ wallet: addressSchema });

/** A page size large enough that one user's instances are one or two queries, never fifty. */
const PAGE = 100;

/**
 * Every instance the user owns, oldest page last.
 *
 * `Repository.list` is keyset-paged for the UI. Walking it here rather than adding an unpaged
 * query keeps the repository's one read path, and a user with more than a hundred strategies is
 * a couple of round trips, not a problem.
 */
async function everyInstance(repo: Repository, user: string) {
  const rows: { instance: InstanceRow; draft: DraftRow }[] = [];
  let cursor: { before: Date; beforeId: string } | undefined;
  for (;;) {
    const page = await repo.list(user, PAGE, cursor?.before, cursor?.beforeId);
    rows.push(...page);
    const last = page[page.length - 1];
    if (page.length < PAGE || !last) return rows;
    cursor = { before: last.instance.createdAt, beforeId: last.instance.id };
  }
}

/**
 * Registers `POST /v1/me/automation`: the one place a wallet's delegation is turned into
 * instance modes.
 *
 * Delegation happens in the client, against Privy; the API never sees a signature. What it does
 * see is the result, and this route is how the client asks the API to look. When the wallet is
 * delegated, every strategy that asked for automatic mode and is signed by this wallet goes
 * auto; when it is not, every one that is currently auto goes manual — and `setMode` pauses the
 * armed ones, because an armed rule the worker can no longer sign for is a rule that silently
 * does nothing.
 */
export async function registerAutomation(
  app: FastifyInstance,
  config: Config,
  deps: AutomationDependencies,
) {
  const { repository: repo } = deps;

  const principal = (request: FastifyRequest) => {
    if (!request.principal) throw Problem.unauthenticated();
    return request.principal;
  };

  app.post(
    "/v1/me/automation",
    {
      schema: {
        tags: ["auth"],
        summary: "Re-read a wallet's delegation and apply it to the user's strategies",
        security: [{ privy: [] }],
        body: z.toJSONSchema(toggleInput, { target: "draft-7", io: "input" }),
      },
      // Every call is a Privy round trip plus a walk over the user's instances. The frontend
      // calls this once per delegation change, not on a poll.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request) => {
      const user = principal(request);
      // Deliberately not gated on eligibility: turning automatic buying OFF must stay available
      // to a user whose region stopped being eligible, and turning it on grants nothing by
      // itself — arm re-checks eligibility before anything runs.
      if (!config.privySignerId) throw automationUnsupported();
      const input = toggleInput.parse(request.body);
      // selectWallet answers 403 wallet-not-linked for an address Privy has not verified for
      // this account; the body is only ever a lookup key against that verified list.
      const wallet = selectWallet(user, input.wallet);
      const embedded = await delegation(deps.wallets, user.privyDid, wallet);
      const delegated = embedded?.delegated === true;
      const now = new Date();
      for (const { instance, draft } of await everyInstance(repo, user.user)) {
        if (TERMINAL.includes(instance.status)) continue;
        if (draft.account !== wallet || draft.mode !== "auto") continue;
        if (delegated && instance.mode !== "auto")
          await repo.setMode(user.user, instance.id, "auto", now);
        else if (!delegated && instance.mode === "auto")
          await repo.setMode(user.user, instance.id, "manual", now);
      }
      return { wallet: wallet as Hex, delegated, signer_id: config.privySignerId };
    },
  );
}
