import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { openPostgres, POSTGRES } from "./harness.js";

/**
 * The application role can do its job with the privileges it is actually granted.
 *
 * Every other suite in this repository runs either against PGlite or against a privileged role,
 * and both of those answer "yes" to any question about permission. So a query the application
 * genuinely cannot run in production passes everywhere except production.
 *
 * That is not hypothetical. `resolvePrivyUser` used `ON CONFLICT DO UPDATE`, which requires the
 * UPDATE privilege; infra/postgres/03-grants.sql grants the API only SELECT and INSERT on
 * `users`, deliberately, because a user row is written once and never mutated. Every suite
 * passed. The moment those grants were applied as written, every single sign-in answered 500
 * with "permission denied for table users" — and because /v1/me, /v1/instances and
 * /v1/portfolio all resolve the caller first, the whole app showed "The request could not be
 * completed" on every page at once, with no user rows ever created.
 *
 * These tests are the guard: they exercise the real repository calls through the real role, so a
 * statement that needs a privilege the grants script withholds fails here rather than in a
 * browser.
 */

describe.skipIf(Boolean(POSTGRES.unavailable))("the application role's privileges", () => {
  const pg = POSTGRES.unavailable ? undefined : openPostgres();
  afterAll(async () => {
    await pg?.close();
  });

  test.skipIf(!POSTGRES.rlsEnforced)(
    "a first sign-in creates the user row, and a second one finds it",
    async () => {
      if (!pg) return;
      const did = `did:privy:grants${randomBytes(12).toString("hex")}`;

      // The insert path. This is what a brand new account does.
      const first = await pg.repo.resolvePrivyUser(did);
      expect(first.privyDid).toBe(did);

      // The conflict path, which is every subsequent request that user ever makes. It must not
      // need UPDATE: the row already says what it needs to say.
      const second = await pg.repo.resolvePrivyUser(did);
      expect(second.id).toBe(first.id);
    },
  );

  test.skipIf(!POSTGRES.rlsEnforced)(
    "the role holds exactly the privileges 03-grants.sql gives it, and no more",
    async () => {
      if (!pg) return;
      // Pinned against the script rather than against what happens to be granted, so widening a
      // privilege in the database without changing the script — which is how the live database
      // had drifted before — fails here.
      const expected: Record<string, string[]> = {
        users: ["INSERT", "SELECT"],
        drafts: ["INSERT", "SELECT", "UPDATE"],
        instances: ["INSERT", "SELECT", "UPDATE"],
        permissions: ["INSERT", "SELECT", "UPDATE"],
        evaluations: ["SELECT"],
      };

      const granted = await pg.pool.query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'mandate_v2' and grantee = current_user`,
      );
      const actual = new Map<string, Set<string>>();
      for (const row of granted.rows) {
        const set = actual.get(row.table_name) ?? new Set<string>();
        set.add(row.privilege_type);
        actual.set(row.table_name, set);
      }

      for (const [table, privileges] of Object.entries(expected)) {
        expect([...(actual.get(table) ?? [])].sort(), table).toEqual(privileges);
      }

      // `transactions` holds signed transaction bytes. The API has no signer and never
      // broadcasts, so it should not be able to read them at all.
      expect(actual.has("transactions")).toBe(false);
    },
  );
});
