import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Problem } from "../../../packages/contracts/src/index.js";
import {
  asTenant,
  countOf,
  discardTenants,
  newTenant,
  openPostgres,
  POSTGRES,
  type Postgres,
  withoutTenant,
} from "./harness.js";
import { caps, forceInstance, seedDraft, seedInstance, seedPermission } from "./seed.js";

/**
 * `Repository` against the role and the policies it actually runs under.
 *
 * The package's own suite runs on PGlite as the bootstrap superuser, where `FORCE ROW LEVEL
 * SECURITY` is inert and a second session does not exist. Everything here needs one or the other:
 * a policy that is enforced, or two transactions contending for the same row.
 */

const suite = describe.skipIf(Boolean(POSTGRES.unavailable));
const tenantSuite = describe.skipIf(Boolean(POSTGRES.unavailable) || !POSTGRES.rlsEnforced);

let pg: Postgres;
let alice: string;
let bob: string;
const created: string[] = [];

beforeAll(async () => {
  if (POSTGRES.unavailable) return;
  pg = openPostgres();
  alice = await newTenant(pg);
  bob = await newTenant(pg);
  created.push(alice, bob);
}, 30_000);

afterAll(async () => {
  if (POSTGRES.unavailable) return;
  await discardTenants(pg, created);
  await pg.close();
}, 30_000);

tenantSuite("row level security under the application role", () => {
  test("a tenant-scoped query cannot see another tenant's instance", async () => {
    const seed = await seedInstance(pg, alice);
    const mine = await asTenant(pg, alice, (query) =>
      countOf(query, "select count(*) from mandate_v2.instances where id = $1", [seed.instance.id]),
    );
    const theirs = await asTenant(pg, bob, (query) =>
      countOf(query, "select count(*) from mandate_v2.instances where id = $1", [seed.instance.id]),
    );
    expect(mine).toBe(1);
    // Not "403", not "0 rows because of a user_id predicate" — the predicate is not even in the
    // statement. The policy is the only thing standing between these two tenants here.
    expect(theirs).toBe(0);
  });

  test("a statement with no tenant context reads nothing at all", async () => {
    const seed = await seedInstance(pg, alice);
    const anonymous = await withoutTenant(pg, (query) =>
      countOf(query, "select count(*) from mandate_v2.instances where id = $1", [seed.instance.id]),
    );
    // `set_config(..., true)` is transaction-local, so a connection returned to the pool carries
    // no identity. A query that forgets `tenant()` fails closed rather than leaking.
    expect(anonymous).toBe(0);
  });

  test("an insert cannot be attributed to another tenant", async () => {
    const seed = await seedInstance(pg, alice);
    // WITH CHECK is the half of the policy that USING does not cover: reading is blocked above,
    // and writing a row stamped with someone else's user_id is blocked here.
    const attempt = asTenant(pg, bob, (query) =>
      query(
        `insert into mandate_v2.evaluations (id, user_id, instance_id, at, outcome, admitted, inputs)
         values (gen_random_uuid(), $1, $2, now(), 'evaluated', 0, '{}'::jsonb)`,
        [alice, seed.instance.id],
      ),
    );
    await expect(attempt).rejects.toThrow();
  });
});

suite("claiming a signed draft", () => {
  test("two concurrent submissions of one draft create exactly one instance", async () => {
    const seed = await seedDraft(pg, alice);
    const draft = await pg.repo.draft(alice, seed.artifactId);
    if (!draft) throw new Error("draft missing");
    const now = new Date();
    const submit = () =>
      pg.repo.createInstance(alice, draft, `0x${"11".repeat(65)}`, draft.name, 12_000, now);

    const outcomes = await Promise.allSettled([submit(), submit()]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser is a deliberate 409, not a unique-violation 500 leaking out of the driver: the
    // claim is `UPDATE ... WHERE consumed_at IS NULL`, and matching no row is the answer.
    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(Problem);
    expect((error as Problem).status).toBe(409);
    expect((error as Problem).code).toBe("draft-consumed");

    const instances = await asTenant(pg, alice, (query) =>
      countOf(query, "select count(*) from mandate_v2.instances where draft_id = $1", [draft.id]),
    );
    expect(instances).toBe(1);
  });

  test("a draft whose envelope has already lapsed is refused after the claim", async () => {
    // The draft itself is still fresh; it is the signed envelope that has expired. Claiming it
    // and then refusing inside the same transaction is what keeps the two from disagreeing.
    const seed = await seedDraft(pg, alice, {
      caps: caps({ expires_at: new Date(Date.now() + 2_000).toISOString() }),
    });
    const draft = await pg.repo.draft(alice, seed.artifactId);
    if (!draft) throw new Error("draft missing");
    const attempt = pg.repo.createInstance(
      alice,
      draft,
      `0x${"11".repeat(65)}`,
      draft.name,
      12_000,
      new Date(Date.now() + 10_000),
    );
    await expect(attempt).rejects.toMatchObject({ status: 409, code: "expired" });
    const consumed = await asTenant(pg, alice, (query) =>
      countOf(
        query,
        "select count(*) from mandate_v2.drafts where id = $1 and consumed_at is not null",
        [draft.id],
      ),
    );
    // The refusal rolled the whole transaction back, so the draft is still claimable.
    expect(consumed).toBe(0);
  });

  test("a draft belonging to another tenant is invisible, not forbidden", async () => {
    const seed = await seedDraft(pg, alice);
    expect(await pg.repo.draft(bob, seed.artifactId)).toBeUndefined();
  });
});

suite("lifecycle transitions", () => {
  test("arming records the jurisdiction attestation and schedules the instance now", async () => {
    const seed = await seedInstance(pg, alice);
    const now = new Date();
    await pg.repo.transition(alice, seed.instance.id, "arm", now, "GB");
    const [row] = await asTenant(pg, alice, (query) =>
      query<{
        status: string;
        eligible_country: string;
        eligibility_expires_at: Date;
        next_tick_at: Date;
      }>(
        "select status, eligible_country, eligibility_expires_at, next_tick_at from mandate_v2.instances where id = $1",
        [seed.instance.id],
      ),
    );
    expect(row?.status).toBe("armed");
    expect(row?.eligible_country).toBe("GB");
    // Twenty-four hours, and it must be a real timestamptz round trip rather than a string.
    expect(row?.eligibility_expires_at.getTime()).toBe(now.getTime() + 86_400_000);
    expect(row?.next_tick_at.getTime()).toBe(now.getTime());
  });

  test("an automatic instance cannot be armed without an active permission", async () => {
    const seed = await seedInstance(pg, alice, { mode: "auto" });
    await forceInstance(pg, alice, seed.instance.id, { mode: "auto" });
    await expect(
      pg.repo.transition(alice, seed.instance.id, "arm", new Date(), "GB"),
    ).rejects.toMatchObject({ status: 409, code: "permission-required" });

    // A permission that exists but has already lapsed is the same refusal, not a pass.
    await seedPermission(pg, alice, seed, {
      status: "active",
      end: Math.floor(Date.now() / 1000) - 10,
    });
    await expect(
      pg.repo.transition(alice, seed.instance.id, "arm", new Date(), "GB"),
    ).rejects.toMatchObject({ status: 409, code: "permission-required" });
  });

  test("a terminal instance refuses arm and pause and absorbs kill without writing", async () => {
    const seed = await seedInstance(pg, alice);
    await pg.repo.transition(alice, seed.instance.id, "kill", new Date());
    const stamp = async () =>
      (
        await asTenant(pg, alice, (query) =>
          query<{ updated_at: Date; halt_reason: string }>(
            "select updated_at, halt_reason from mandate_v2.instances where id = $1",
            [seed.instance.id],
          ),
        )
      )[0];
    const before = await stamp();
    expect(before?.halt_reason).toBe("Stopped by user");

    for (const action of ["arm", "pause"] as const)
      await expect(
        pg.repo.transition(alice, seed.instance.id, action, new Date(), "GB"),
      ).rejects.toMatchObject({ status: 409, code: "terminal-instance" });

    await pg.repo.transition(alice, seed.instance.id, "kill", new Date());
    const after = await stamp();
    // A second kill must not relabel the halt or bump the row: "already stopped" is not an event.
    expect(after?.updated_at.getTime()).toBe(before?.updated_at.getTime());
    expect(after?.halt_reason).toBe("Stopped by user");
  });

  test("another tenant's instance is a 404 from every repository read", async () => {
    const seed = await seedInstance(pg, alice);
    await expect(pg.repo.detail(bob, seed.instance.id)).rejects.toMatchObject({ status: 404 });
    await expect(pg.repo.permission(bob, seed.instance.id)).rejects.toMatchObject({ status: 404 });
    await expect(pg.repo.history(bob, seed.instance.id, "executions", 10)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      pg.repo.transition(bob, seed.instance.id, "kill", new Date()),
    ).rejects.toMatchObject({ status: 404 });
  });
});

suite("authority immutability", () => {
  test("a consumed draft cannot be re-armed by rewriting its envelope", async () => {
    const seed = await seedInstance(pg, alice);
    const attempt = asTenant(pg, alice, (query) =>
      query("update mandate_v2.drafts set envelope = $2 where id = $1", [
        seed.draft.id,
        JSON.stringify({
          ...seed.envelope,
          caps: caps({ lifetime: "1000000", per_period: "1000000", per_order: "1000000" }),
        }),
      ]),
    );
    // 23514 from the immutable_draft trigger. The signature covers the envelope, so an envelope
    // that can be edited after signing is an authority nobody actually granted.
    await expect(attempt).rejects.toMatchObject({ code: "23514" });
  });

  test("an instance's signature and draft binding cannot be moved", async () => {
    const seed = await seedInstance(pg, alice);
    const attempt = asTenant(pg, alice, (query) =>
      query("update mandate_v2.instances set signature = $2 where id = $1", [
        seed.instance.id,
        `0x${"ff".repeat(65)}`,
      ]),
    );
    await expect(attempt).rejects.toMatchObject({ code: "23514" });
  });

  test("a permission signature is write-once", async () => {
    const seed = await seedInstance(pg, alice, { mode: "auto" });
    const permission = await seedPermission(pg, alice, seed, { status: "signed" });
    const attempt = asTenant(pg, alice, (query) =>
      query("update mandate_v2.permissions set signature = $2 where id = $1", [
        permission.id,
        `0x${"cd".repeat(65)}`,
      ]),
    );
    await expect(attempt).rejects.toMatchObject({ code: "23514" });
    // Status still moves: that is the one field the grant lifecycle is allowed to change.
    await asTenant(pg, alice, (query) =>
      query(
        "update mandate_v2.permissions set status = 'active', updated_at = now() where id = $1",
        [permission.id],
      ),
    );
  });
});
