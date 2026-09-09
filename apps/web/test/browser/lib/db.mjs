import { execSync } from "node:child_process";

/**
 * Direct reads of the fork database, so a check can say what was actually written rather than
 * what the screen implies was written.
 */
export const DB = "postgresql://mandate_admin@127.0.0.1:5432/mandate_fork";
/** The injected test wallet's address (see session.mjs), lower-cased as the API stores it. */
export const ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

export const sql = (q) =>
  execSync(`psql "${DB}" -tAc "${q.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();

export const row = (q) => JSON.parse(sql(`select row_to_json(x) from (${q}) x`) || "null");
export const rows = (q) =>
  JSON.parse(sql(`select coalesce(json_agg(x), '[]') from (${q}) x`) || "[]");

/** How many strategy instances the test wallet owns. */
export const mine = () =>
  Number(
    sql(
      `select count(*) from mandate_v2.instances i join mandate_v2.drafts d on d.id=i.draft_id where d.account='${ACCOUNT}'`,
    ),
  );

/** The newest instance a wallet owns, with the draft fields a check tends to need. */
export const latestDraftFor = (account) =>
  row(
    `select i.id, d.mode, d.name, d.envelope->'caps' as caps, d.envelope->'assets' as assets, i.mode as instance_mode, i.status from mandate_v2.drafts d join mandate_v2.instances i on i.draft_id=d.id where d.account='${account.toLowerCase()}' order by i.created_at desc limit 1`,
  );
/** The newest instance the test wallet owns. */
export const latestDraft = () => latestDraftFor(ACCOUNT);
