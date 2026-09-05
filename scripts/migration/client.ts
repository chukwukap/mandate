import { Problem } from "../../packages/contracts/src/index.js";
import { connectDatabase } from "../../packages/database/src/client.js";
import type { SqlClient } from "./sql.js";
import { widenStatementTimeout } from "./sql.js";

/**
 * One dedicated PostgreSQL session, not a pool handle.
 *
 * `withTransaction` and `asTenant` are meaningless on a pool: `begin` checks out a connection,
 * the next statement may land on a different one, and the tool would appear to run inside a
 * transaction while writing outside it — the failure mode where a rollback rolls nothing back.
 * So every entry point takes one checked-out client and returns it when it is done.
 *
 * The pool comes from `@mandate/database` rather than from `pg` directly. `pg` is a dependency
 * of that package and, under this workspace's isolated installs, is not resolvable from
 * `scripts/`; adding it to the root manifest for one script would put a driver in the tool
 * belt of everything else. The drizzle wrapper `connectDatabase` returns is simply unused
 * here — this tool speaks SQL, because the schema it reads is not the schema drizzle models.
 */

export type Session = {
  readonly client: SqlClient;
  /** Release the connection and close the pool. Safe to call twice. */
  close(): Promise<void>;
};

/**
 * Open a session.
 *
 * The URL is validated but NEVER logged, echoed into a report or put in an error message: it
 * carries the database password. Errors name the `label` instead, which is why one is
 * required — "could not connect to the legacy database" is actionable, and
 * "postgres://mandate:hunter2@..." is an incident.
 */
export async function openSession(url: string, label: string): Promise<Session> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Problem(
      400,
      "invalid-connection",
      "Unusable connection string",
      `The ${label} connection string could not be parsed as a URL.`,
    );
  }
  if (!["postgres:", "postgresql:"].includes(protocol))
    throw new Problem(
      400,
      "invalid-connection",
      "Unusable connection string",
      `The ${label} connection string must be a postgres:// or postgresql:// URL.`,
    );

  const connection = connectDatabase(url);
  // `pool.connect()` is overloaded — a promise form and a callback form — so
  // `ReturnType<typeof pool.connect>` resolves to the callback overload's `void` and the
  // checked-out client loses its type. Inferring from the call expression instead picks the
  // promise overload, which is the one being used.
  const client = await connection.pool.connect().catch(async (): Promise<never> => {
    await connection.close().catch(() => undefined);
    throw new Problem(
      503,
      "connection-failed",
      "Could not connect",
      `The ${label} database refused the connection or was unreachable.`,
    );
  });
  const session: SqlClient = {
    // `pg` mutates the parameter array it is given, so the readonly one from the caller is
    // copied rather than passed through.
    query: async (text, params) => client.query(text, params === undefined ? [] : [...params]),
  };
  let released = false;
  try {
    await widenStatementTimeout(session);
  } catch (error) {
    client.release();
    released = true;
    await connection.close().catch(() => undefined);
    throw error;
  }
  return {
    client: session,
    close: async () => {
      if (!released) {
        released = true;
        client.release();
      }
      await connection.close().catch(() => undefined);
    },
  };
}

/**
 * Are two connection strings pointed at the same database?
 *
 * Importing a database into itself is an operator error that produces an inscrutable mess:
 * the legacy reader would see `mandate_v2` tables that are not there, or worse, the two
 * halves would half-work. Compared on host, port and database name, with the credentials
 * ignored — the same server reached as two different users is still the same server.
 */
export function sameDatabase(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.hostname === right.hostname &&
      (left.port || "5432") === (right.port || "5432") &&
      left.pathname === right.pathname
    );
  } catch {
    return false;
  }
}
