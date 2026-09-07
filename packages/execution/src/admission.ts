import { randomUUID } from "node:crypto";
import type { ChainReader, Hex } from "@mandate/contracts";
import { type DraftRow, type InstanceRow, schema, type WorkerStore } from "@mandate/database";
import { ASSETS, CHAIN_ID, USDC } from "@mandate/evm";
import {
  canonical,
  capsSchema,
  digest,
  type Portfolio,
  review,
  tick,
  units,
  validatePlan,
} from "@mandate/strategy";
import { eq } from "drizzle-orm";
import type { Context } from "./lifecycle.js";

export type Snapshot = { at: number; feeds: Record<string, string>; portfolio: Portfolio };
export interface Observations extends Pick<ChainReader, "verifyMessage"> {
  snapshot(draft: DraftRow): Promise<Snapshot>;
  authorize(context: Context): Promise<unknown>;
}
export async function verifyCommitment(
  draft: DraftRow,
  instance: InstanceRow,
  origin: string,
  chain: Pick<ChainReader, "verifyMessage">,
) {
  const e = draft.envelope;
  if (
    e.version !== "mandate/2" ||
    e.venue !== "aerodrome" ||
    e.quote.toLowerCase() !== USDC.toLowerCase()
  )
    throw new Error("Unsupported envelope");
  capsSchema.parse(e.caps);
  for (const asset of e.assets) {
    const known = ASSETS.find((a) => a.token.toLowerCase() === asset.token.toLowerCase());
    if (!known || canonical(known) !== canonical(asset))
      throw new Error("Asset catalogue mismatch");
  }
  validatePlan(draft.plan, e.assets);
  const rendered = review(draft.plan, e);
  const artifact = digest({
    id: draft.id,
    user: draft.userId,
    account: draft.account,
    name: draft.name,
    mode: draft.mode,
    plan: draft.plan,
    envelope: e,
    render: rendered.render_text,
    expires: draft.expiresAt.toISOString(),
  });
  const message = `Mandate strategy authorization\nOrigin: ${origin}\nChain: ${CHAIN_ID}\nAccount: ${draft.account}\nArtifact: ${artifact}\nName: ${draft.name}\nRequested mode: ${draft.mode}\nSign before: ${draft.expiresAt.toISOString()}\n\n${rendered.render_text}`;
  if (
    artifact !== draft.artifactId ||
    rendered.render_sha256 !== draft.renderHash ||
    rendered.render_text !== draft.renderText ||
    message !== draft.confirmMessage ||
    !draft.consumedAt ||
    draft.consumedAt >= draft.expiresAt ||
    !(await chain.verifyMessage(draft.account as Hex, message, instance.signature as Hex))
  )
    throw new Error("Invalid signed strategy commitment");
}
/** Thrown only by the commitment check, so the catch below can tell it from an outage. */
class InvalidCommitment extends Error {}

export class Admission {
  constructor(
    private readonly store: WorkerStore,
    private readonly chain: Observations,
    private readonly origin: string,
    private readonly execute: boolean,
    private readonly countries: readonly string[],
    /**
     * Called when a stored strategy fails to verify. Injected rather than logged here because
     * this package holds no logger, and a swallowed security event is the thing being fixed.
     */
    private readonly onInvalidCommitment?: (instanceId: string, error: unknown) => void,
  ) {}
  async run(instance: InstanceRow, draft: DraftRow) {
    let snapshot: Snapshot | undefined;
    let failure: string | undefined;
    try {
      // Separated from the rest of the try on purpose. A commitment that does not verify means
      // the row did not come from the API accepting a signature, and reporting that as
      // "observation-or-authority-unavailable" sends an operator to look at their RPC while a
      // forged strategy sits in the table. Verified: a direct insert with a bogus signature was
      // correctly refused here and correctly named nothing at all.
      try {
        await verifyCommitment(draft, instance, this.origin, this.chain);
      } catch (error) {
        this.onInvalidCommitment?.(instance.id, error);
        throw new InvalidCommitment();
      }
      if (instance.mode === "auto" && !this.execute) failure = "execution-disabled";
      else if (
        instance.mode === "auto" &&
        (!instance.eligibleCountry ||
          !this.countries.includes(instance.eligibleCountry) ||
          !instance.eligibilityExpiresAt ||
          instance.eligibilityExpiresAt.getTime() <= Date.now())
      )
        failure = "eligibility-renewal-required";
      else {
        if (instance.mode === "auto")
          await this.chain.authorize(await this.store.context(instance.userId, instance.id));
        snapshot = await this.chain.snapshot(draft);
      }
    } catch (error) {
      failure =
        error instanceof InvalidCommitment
          ? "invalid-commitment"
          : "observation-or-authority-unavailable";
    }
    await this.store.write(instance.userId, async (tx) => {
      const current = await this.store.lockInstance(tx, instance.id);
      const now = new Date();
      if (
        current.status !== "armed" ||
        current.updatedAt.getTime() !== instance.updatedAt.getTime() ||
        current.nextTickAt > now
      )
        return;
      if (snapshot && now.getTime() - snapshot.at > 30000) {
        snapshot = undefined;
        failure = "observation-expired";
      }
      const expired = Date.parse(draft.envelope.caps.expires_at) <= now.getTime();
      const result =
        snapshot && !expired
          ? tick(
              draft.plan,
              draft.envelope,
              current.runtime,
              snapshot.feeds,
              snapshot.portfolio,
              now.getTime(),
            )
          : undefined;
      // Halt always prevents new transfers in this tick, including earlier actions.
      const intents = result?.state.halted ? [] : (result?.intents ?? []);
      await tx.insert(schema.evaluations).values({
        id: randomUUID(),
        userId: current.userId,
        instanceId: current.id,
        at: now,
        outcome: expired ? "expired" : (failure ?? (result?.state.halted ? "halted" : "evaluated")),
        inputs: snapshot?.feeds ?? {},
        admitted: intents.length,
        refused: result?.refused.join("; ") || failure || null,
        notifications: result?.notifications ?? [],
      });
      for (const intent of intents) {
        const asset = draft.envelope.assets[intent.asset];
        if (!asset) throw new Error("Unknown intent asset");
        await tx.insert(schema.executions).values({
          id: randomUUID(),
          userId: current.userId,
          instanceId: current.id,
          status: current.mode === "auto" ? "admitted" : "signal",
          tokenIn: intent.side === "buy" ? USDC : asset.token,
          tokenOut: intent.side === "buy" ? asset.token : USDC,
          amountIn: units(intent.amount, intent.side === "buy" ? 6 : asset.decimals).toString(),
          intent,
          createdAt: now,
          updatedAt: now,
        });
      }
      await tx
        .update(schema.instances)
        .set({
          runtime: result?.state ?? current.runtime,
          status: expired
            ? "ended"
            : result?.state.halted
              ? "halted"
              : failure === "eligibility-renewal-required"
                ? "paused"
                : current.status,
          haltReason: expired
            ? "Strategy expired"
            : result?.state.halted
              ? (result.notifications.at(-1) ?? "Strategy halted")
              : current.haltReason,
          updatedAt: now,
          lastTickAt: now,
          nextTickAt: new Date(
            now.getTime() +
              (failure ? Math.max(30000, current.tickIntervalMs) : current.tickIntervalMs),
          ),
        })
        .where(eq(schema.instances.id, current.id));
    });
  }
}
