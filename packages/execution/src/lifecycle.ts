import { randomUUID } from "node:crypto";
import type { ExecutionRow, TransactionRow, WorkerStore } from "@mandate/database";
import { schema } from "@mandate/database";
import { eq } from "drizzle-orm";

export type Context = Awaited<ReturnType<WorkerStore["context"]>>;
export type Leg = "fund" | "approve" | "swap" | "reset" | "refund";
export type Prepared = Pick<
  TransactionRow,
  "signer" | "nonce" | "rawTransaction" | "hash" | "evidence"
>;
export type Observation = "pending" | "confirmed" | "reverted" | "ambiguous";
export interface Executor {
  prepare(leg: Leg, order: ExecutionRow, context: Context): Promise<Prepared>;
  observe(transaction: TransactionRow): Promise<Observation>;
  broadcast(transaction: TransactionRow): Promise<void>;
}
export class RecoveryRequired extends Error {}
export class Lifecycle {
  constructor(
    private readonly store: WorkerStore,
    private readonly chain: Executor,
    private readonly timeoutMs: number,
  ) {}
  private async status(
    order: ExecutionRow,
    status: string,
    stage: string,
    reason: string | null = null,
  ) {
    await this.store.write(order.userId, async (tx) => {
      await tx
        .update(schema.executions)
        .set({ status, stage, reason, updatedAt: new Date() })
        .where(eq(schema.executions.id, order.id));
      if (status === "recovery_required")
        await tx
          .update(schema.instances)
          .set({ status: "halted", haltReason: reason, updatedAt: new Date() })
          .where(eq(schema.instances.id, order.instanceId));
    });
  }
  async run(order: ExecutionRow) {
    if (order.status === "recovery_required") return;
    const journal = await this.store.journal(order.userId, order.id);
    for (const confirmed of journal.filter((t) => t.status !== "signed")) {
      if ((await this.chain.observe(confirmed)) !== confirmed.status) {
        await this.status(
          order,
          "recovery_required",
          confirmed.leg,
          "Previously settled receipt changed",
        );
        return;
      }
    }
    const pending = journal.find((t) => t.status === "signed");
    if (pending) {
      // Never infer success from nonce alone, and never sign a replacement here.
      const observed = await this.chain.observe(pending);
      if (
        observed === "ambiguous" ||
        (observed === "pending" && Date.now() - pending.createdAt.getTime() > this.timeoutMs)
      ) {
        await this.status(
          order,
          "recovery_required",
          pending.leg,
          "Unresolved transaction evidence; inspect journal before recovery",
        );
        return;
      }
      if (observed === "pending") {
        await this.store.write(order.userId, async () => {});
        await this.chain.broadcast(pending);
        return;
      }
      await this.store.write(order.userId, async (tx) => {
        await tx
          .update(schema.transactions)
          .set({ status: observed, confirmedAt: new Date() })
          .where(eq(schema.transactions.id, pending.id));
        await tx
          .update(schema.executions)
          .set({ txHash: pending.hash, updatedAt: new Date() })
          .where(eq(schema.executions.id, order.id));
      });
      return; // Next poll derives the next leg from the durable receipt.
    }
    const fund = journal.find((t) => t.leg === "fund");
    const swap = journal.find((t) => t.leg === "swap");
    const refund = journal.find((t) => t.leg === "refund");
    if (fund?.status === "reverted") {
      await this.status(order, "reverted", "fund", "Funding reverted");
      return;
    }
    if (swap?.status === "confirmed") {
      await this.status(order, "confirmed", "done");
      return;
    }
    if (refund?.status === "confirmed") {
      await this.status(order, "refunded", "done", "Input returned to strategy account");
      return;
    }
    if (
      refund?.status === "reverted" ||
      journal.some((t) => t.leg === "reset" && t.status === "reverted")
    ) {
      await this.status(
        order,
        "recovery_required",
        order.stage,
        "Refund or allowance reset reverted",
      );
      return;
    }
    const context = await this.store.context(order.userId, order.instanceId);
    const stopped =
      context.instance.status !== "armed" ||
      context.instance.mode !== "auto" ||
      Date.parse(context.draft.envelope.caps.expires_at) <= Date.now();
    if (!fund && stopped) {
      await this.status(order, "cancelled", "fund", "Strategy no longer armed");
      return;
    }
    const returning =
      order.stage === "reset" ||
      order.stage === "refund" ||
      stopped ||
      swap?.status === "reverted" ||
      journal.some((t) => t.leg === "approve" && t.status === "reverted");
    const leg: Leg = !fund
      ? "fund"
      : returning
        ? journal.some((t) => t.leg === "reset" && t.status === "confirmed")
          ? "refund"
          : "reset"
        : journal.some((t) => t.leg === "approve" && t.status === "confirmed")
          ? "swap"
          : "approve";
    let prepared: Prepared;
    try {
      prepared = await this.chain.prepare(leg, order, context);
    } catch (error) {
      if (error instanceof RecoveryRequired || leg === "reset" || leg === "refund")
        await this.status(
          order,
          "recovery_required",
          leg,
          "Cannot establish safe execution or refund",
        );
      else if (!fund)
        await this.status(order, "cancelled", leg, "Admission checks failed before funding");
      else
        await this.status(
          order,
          "pending",
          "reset",
          "Execution unavailable; returning funded input",
        );
      return;
    }
    await this.store.write(order.userId, async (tx) => {
      const current = await this.store.lockInstance(tx, order.instanceId);
      if (
        (leg === "fund" || leg === "approve" || leg === "swap") &&
        (current.status !== "armed" ||
          current.mode !== "auto" ||
          current.updatedAt.getTime() !== context.instance.updatedAt.getTime())
      )
        return;
      await tx.insert(schema.transactions).values({
        id: randomUUID(),
        userId: order.userId,
        executionId: order.id,
        leg,
        ...prepared,
        createdAt: new Date(),
      });
      await tx
        .update(schema.executions)
        .set({ status: "pending", stage: leg, updatedAt: new Date() })
        .where(eq(schema.executions.id, order.id));
    });
    // Only the subsequent journal read can broadcast. A failed commit leaves no
    // recoverable transaction and this process never sends unjournaled bytes.
  }
}
