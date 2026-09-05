import { writeFile } from "node:fs/promises";
import { Problem } from "../../packages/contracts/src/index.js";
import { ASSETS } from "../../packages/evm/src/addresses/index.js";
import { applyMigration, targetDirectory } from "./apply.js";
import { openSession, sameDatabase } from "./client.js";
import { loadLinkFile } from "./identity.js";
import { listRuns } from "./journal.js";
import { openLegacySource } from "./legacy.js";
import type { MigrationPlan } from "./plan.js";
import { planMigration } from "./plan.js";
import { applyReport, planDocument, planReport, rollbackReport } from "./report.js";
import { rollbackMigration } from "./rollback.js";
import type { SqlClient } from "./sql.js";

/**
 * The command line.
 *
 * Four verbs, and the first two are the same code path: `plan` builds the plan and prints it,
 * `apply` builds the same plan and then writes it. There is no way to apply something that was
 * not planned in the same process against the same two databases seconds earlier, which is
 * what keeps the printed report honest — a plan file loaded from disk and applied later would
 * be a description of a database that has since moved on.
 *
 * Configuration is read from the environment and the flags, not from `@mandate/config`. That
 * loader demands Privy credentials, an application database URL and a spender address, none of
 * which this tool uses; requiring them would mean handing a one-shot migration script a set of
 * production secrets it has no business being able to read.
 */

const TOOL_VERSION = "mandate-migration/1.0.0";

const USAGE = `Usage: bun scripts/migration/run.ts <command> [options]

Commands:
  plan                 Read both databases and print what would be written. Writes nothing.
  apply                Do the same, then write it in one transaction and journal the result.
  rollback --run <id>  Undo one applied run using its journal.
  runs                 List the runs this database's journal holds.

Environment:
  LEGACY_DATABASE_URL     The Rust deployment's database. Must be a BYPASSRLS or superuser
                          role: the legacy tables force row-level security and any other role
                          reads zero rows without erroring.
  MIGRATION_DATABASE_URL  The mandate_v2 database, as the schema owner.
  MIGRATION_LINKS         Path to the wallet -> Privy DID link file (JSON).
  APP_ORIGIN              The origin users will sign against. It is inside the signed text.

Options:
  --slippage-bps <n>     Slippage bound written into every migrated envelope (default 50).
  --signing-window <ms>  How long a migrated review stays signable (default 604800000, 7 days).
  --expires-at <iso>     Replacement expiry for authorities that have already lapsed.
                         Without it, a lapsed authority is refused rather than extended.
  --mode carry|manual    Carry the legacy run mode, or downgrade everything to manual.
                         Default: manual.
  --user <legacy-id>     Limit the run to one legacy user. Repeatable.
  --legacy-schema <name> The legacy schema (default public).
  --source <label>       How this legacy database is named in the report and journal.
  --out <path>           Also write the machine-readable plan to this JSON file.
  --strict               Rollback only: abort and delete nothing if any row must be retained.
`;

type Flags = {
  readonly command: string;
  readonly values: ReadonlyMap<string, string[]>;
  readonly switches: ReadonlySet<string>;
};

/**
 * Argument parsing, by hand.
 *
 * No dependency for four flags, and — more to the point — an unknown flag is an error rather
 * than something silently ignored. `--slipage-bps 10` quietly applying the 50 bps default to
 * every migrated strategy is precisely the class of mistake this whole tool exists to make
 * impossible.
 */
export function parseArguments(argv: readonly string[]): Flags {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const known = new Set([
    "slippage-bps",
    "signing-window",
    "expires-at",
    "mode",
    "user",
    "legacy-schema",
    "source",
    "out",
    "run",
  ]);
  const flags = new Set(["strict", "help"]);
  const command = argv[0] ?? "";
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--"))
      throw new Problem(400, "bad-arguments", "Unexpected argument", `Unexpected "${token}".`);
    const name = token.slice(2);
    if (flags.has(name)) {
      switches.add(name);
      continue;
    }
    if (!known.has(name))
      throw new Problem(400, "bad-arguments", "Unknown option", `Unknown option "${token}".`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Problem(400, "bad-arguments", "Missing value", `"${token}" needs a value.`);
    values.set(name, [...(values.get(name) ?? []), value]);
    index += 1;
  }
  return { command, values, switches };
}

function single(flags: Flags, name: string): string | undefined {
  const list = flags.values.get(name);
  if (list && list.length > 1)
    throw new Problem(
      400,
      "bad-arguments",
      "Repeated option",
      `--${name} was given ${list.length} times; it takes one value.`,
    );
  return list?.[0];
}

function integerFlag(flags: Flags, name: string, fallback: number, min: number, max: number) {
  const raw = single(flags, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Problem(
      400,
      "bad-arguments",
      "Invalid option",
      `--${name} must be a whole number between ${min} and ${max}.`,
    );
  return parsed;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Problem(400, "missing-configuration", "Missing configuration", `Set ${name}.`);
  return value;
}

/**
 * The origin, checked the way the API checks it.
 *
 * It is embedded in the text every migrated user signs, so a trailing slash or a stray path
 * produces a message their wallet will happily sign and this deployment will then refuse to
 * verify — discovered by the user, at the moment they try, with nothing to tell them why.
 */
function readOrigin(): string {
  const raw = required("APP_ORIGIN");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Problem(400, "missing-configuration", "Invalid origin", "APP_ORIGIN is not a URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== raw ||
    url.username ||
    url.password
  )
    throw new Problem(
      400,
      "missing-configuration",
      "Invalid origin",
      "APP_ORIGIN must be a bare http(s) origin with no path, no trailing slash and no credentials.",
    );
  return url.origin;
}

type Built = {
  readonly plan: MigrationPlan;
  /** The open `mandate_v2` session the plan was built against. `apply` writes through it. */
  readonly client: SqlClient;
  close: () => Promise<void>;
};

async function buildPlan(flags: Flags): Promise<Built> {
  const legacyUrl = required("LEGACY_DATABASE_URL");
  const targetUrl = required("MIGRATION_DATABASE_URL");
  if (sameDatabase(legacyUrl, targetUrl))
    throw new Problem(
      400,
      "same-database",
      "Both URLs name one database",
      "LEGACY_DATABASE_URL and MIGRATION_DATABASE_URL point at the same database. A migration reads one and writes the other.",
    );
  const links = await loadLinkFile(required("MIGRATION_LINKS"));
  const origin = readOrigin();
  const mode = single(flags, "mode") ?? "manual";
  if (mode !== "carry" && mode !== "manual")
    throw new Problem(400, "bad-arguments", "Invalid option", "--mode is carry or manual.");
  const expiresAt = single(flags, "expires-at");
  if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt)))
    throw new Problem(
      400,
      "bad-arguments",
      "Invalid option",
      "--expires-at must be an ISO 8601 instant with an offset.",
    );

  const legacySession = await openSession(legacyUrl, "legacy");
  let targetSession: Awaited<ReturnType<typeof openSession>> | undefined;
  try {
    targetSession = await openSession(targetUrl, "mandate_v2");
    const legacy = await openLegacySource(
      legacySession.client,
      single(flags, "legacy-schema") ?? "public",
    );
    const plan = await planMigration(
      { legacy, target: targetDirectory(targetSession.client), links },
      {
        origin,
        now: new Date(),
        catalogue: ASSETS,
        slippageBps: integerFlag(flags, "slippage-bps", 50, 1, 500),
        signingWindowMs: integerFlag(flags, "signing-window", 7 * 24 * 3_600_000, 60_000, 2_592_000_000),
        expiresAt,
        mode,
        source: single(flags, "source") ?? "legacy",
        onlyUsers: flags.values.get("user"),
      },
    );
    const target = targetSession;
    // The legacy session is finished with the moment the plan exists; the target session is
    // handed back because `apply` writes through it, and because a plan built against one
    // connection and applied through another is a plan applied to a database nobody read.
    await legacySession.close();
    return { plan, client: target.client, close: () => target.close() };
  } catch (error) {
    await legacySession.close();
    await targetSession?.close();
    throw error;
  }
}

async function main(): Promise<number> {
  const flags = parseArguments(process.argv.slice(2));
  if (flags.command === "" || flags.switches.has("help") || flags.command === "help") {
    process.stdout.write(USAGE);
    return flags.command === "" ? 1 : 0;
  }
  switch (flags.command) {
    case "plan": {
      const { plan, close } = await buildPlan(flags);
      try {
        process.stdout.write(`${planReport(plan, TOOL_VERSION)}\n`);
        await writePlanFile(flags, plan);
      } finally {
        await close();
      }
      return plan.issues.length > 0 ? 2 : 0;
    }
    case "apply": {
      const { plan, client, close } = await buildPlan(flags);
      try {
        // The plan is printed BEFORE it is applied, and again nothing about the write path
        // can change it. An operator whose apply fails still has the full report of what it
        // was going to do, which is the document they need to work the refusals.
        process.stdout.write(`${planReport(plan, TOOL_VERSION)}\n\n`);
        await writePlanFile(flags, plan);
        const result = await applyMigration(client, plan, {
          toolVersion: TOOL_VERSION,
          now: new Date(),
        });
        process.stdout.write(`${applyReport(plan, result, result.runId)}\n`);
      } finally {
        await close();
      }
      return 0;
    }
    case "rollback": {
      const runId = single(flags, "run");
      if (!runId)
        throw new Problem(400, "bad-arguments", "Missing run", "rollback needs --run <run id>.");
      const session = await openSession(required("MIGRATION_DATABASE_URL"), "mandate_v2");
      try {
        const result = await rollbackMigration(session.client, runId, {
          now: new Date(),
          strict: flags.switches.has("strict"),
        });
        process.stdout.write(`${rollbackReport(result)}\n`);
        return result.status === "rolled_back" ? 0 : 2;
      } finally {
        await session.close();
      }
    }
    case "runs": {
      const session = await openSession(required("MIGRATION_DATABASE_URL"), "mandate_v2");
      try {
        const runs = await listRuns(session.client);
        if (runs.length === 0) process.stdout.write("No migration runs in this database.\n");
        for (const run of runs)
          process.stdout.write(
            `${run.id}  ${run.status.padEnd(22)}  ${run.finishedAt.toISOString()}  ${run.source}  ${run.toolVersion}\n`,
          );
      } finally {
        await session.close();
      }
      return 0;
    }
    default:
      process.stderr.write(`Unknown command "${flags.command}".\n\n${USAGE}`);
      return 1;
  }
}

async function writePlanFile(flags: Flags, plan: MigrationPlan): Promise<void> {
  const out = single(flags, "out");
  if (!out) return;
  await writeFile(out, `${JSON.stringify(planDocument(plan, TOOL_VERSION), null, 2)}\n`, "utf8");
  process.stdout.write(`Plan written to ${out}\n`);
}

/**
 * Errors are reported, never thrown at the terminal.
 *
 * A stack trace from `pg` can carry the connection string, and this tool holds two of them.
 * `Problem` already carries a title and a human-readable detail; anything else is reported as
 * its message alone, with the object it came from left unlogged.
 */
if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof Problem)
      process.stderr.write(`${error.title}: ${error.detail}\n`);
    else process.stderr.write(`${error instanceof Error ? error.message : "Unknown failure"}\n`);
    process.exitCode = 1;
  }
}
