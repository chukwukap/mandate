/**
 * Spender key custody.
 *
 * Two halves that belong together: `custody.ts` states what holding this key actually means
 * for a user's money, and `spender.ts` + `redaction.ts` keep the key itself from leaking
 * into a log, an error or a crash report. Neither is useful without the other — a perfectly
 * guarded key still sits in front of a custodial window, and an honest disclosure does not
 * help if the key ends up in a stack trace.
 */

export type { Custody, CustodyHolder, CustodyLeg } from "./custody.js";
export { CUSTODY_DISCLOSURE, CUSTODY_SEQUENCE, custodial, custody } from "./custody.js";
export { NO_SECRETS, REDACTED, Redactor } from "./redaction.js";
export type { DeriveAddress, SpenderKeyOptions } from "./spender.js";
export { SpenderKey, takeEnvKey } from "./spender.js";
