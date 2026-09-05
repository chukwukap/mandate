import { type Database, schema, tenant, type Transaction } from "@mandate/database";
import { asc, gt } from "drizzle-orm";

/** Owners read per round trip. Matches WorkerStore.activeExecution's page size. */
const PAGE = 100;

/**
 * Visit every owner's tenant context, in id order, with a LOCAL cursor.
 *
 * `WorkerStore.owners()` cannot be used here. It advances a cursor held on the shared
 * WorkerStore instance that the scheduling loop in worker.ts also reads: a recovery pass
 * calling it would silently skip a page of owners for that loop, and the due strategies on
 * that page would never tick. The bug would present as "some users just stopped trading",
 * with nothing in the logs. So recovery pages owners itself, exactly as
 * `WorkerStore.activeExecution` and `jobs/execute-intent.ts` already do.
 *
 * `users` carries no tenant policy, so the page query itself needs no context; every read
 * of owned data happens inside `tenant()` so row-level security still applies.
 *
 * `visit` returning `"stop"` ends the walk early and still counts as complete, because the
 * caller found what it was looking for. `complete` is false only when the `maxOwners` bound
 * cut the walk short, so a caller can label a partial answer as a lower bound rather than
 * presenting it as a fact. A bound is required: an owner scan is proportional to the user
 * count and recovery runs it while the fleet-wide admission gate is already held.
 */
export async function eachOwner(
  db: Database,
  maxOwners: number,
  visit: (userId: string, tx: Transaction) => Promise<"stop" | void>,
): Promise<{ complete: boolean; visited: number }> {
  let cursor: string | undefined;
  let visited = 0;
  while (visited < maxOwners) {
    const limit = Math.min(PAGE, maxOwners - visited);
    const page = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(cursor ? gt(schema.users.id, cursor) : undefined)
      .orderBy(asc(schema.users.id))
      .limit(limit);
    for (const owner of page) {
      visited += 1;
      if ((await tenant(db, owner.id, (tx) => visit(owner.id, tx))) === "stop")
        return { complete: true, visited };
    }
    // A short page is the end of the table; a full page under a reduced limit is not.
    if (page.length < limit) return { complete: true, visited };
    cursor = page.at(-1)?.id;
  }
  return { complete: false, visited };
}
