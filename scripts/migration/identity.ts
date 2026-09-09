import { readFile } from "node:fs/promises";
import { Problem } from "../../packages/contracts/src/index.js";
import { BASE_CAIP2 } from "./catalogue.js";
import { issue, Refused } from "./issues.js";
import type { LegacyUser } from "./legacy.js";

/**
 * Who a legacy user becomes here.
 *
 * The two deployments authenticate differently and there is no derivation between them. The
 * Rust API signed users in with ERC-4361 over a wallet; this one signs them in with Privy and
 * `users.privy_did` carries a `~ '^did:privy:[A-Za-z0-9]+$'` check specifically so a wallet
 * address can never be used as a stand-in for an identity. There is therefore no honest way
 * for this tool to invent the link, and it does not try: the mapping is supplied as a file
 * that somebody with access to both systems produced, and a user who is not in it is
 * reported as unmigratable rather than given a fabricated DID.
 */

const DID_PATTERN = /^did:privy:[A-Za-z0-9]+$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

export type IdentityLink = {
  /** Lowercase `0x` wallet address as the legacy `wallet` table holds it. */
  readonly wallet: string;
  readonly privyDid: string;
  /**
   * The account migrated strategies should spend from, when the operator wants to pin one.
   * Optional: it is usually derivable, and this exists for the users where it is not.
   */
  readonly account?: string | undefined;
};

export type LinkTable = {
  readonly byWallet: ReadonlyMap<string, IdentityLink>;
};

export const LINK_FILE_VERSION = "mandate/migration-links/1";

/**
 * Parse and cross-check a link file.
 *
 * Two wallets pointing at one DID is normal — a person may have signed in from an EOA and a
 * Base Account. One wallet pointing at two DIDs is not, and it is refused at parse time
 * rather than at use time, because by the time it is discovered mid-import half the drafts
 * are already written under whichever DID happened to be read first.
 */
export function parseLinkFile(input: unknown, sourceName: string): LinkTable {
  const document = input as { version?: unknown; links?: unknown };
  if (document?.version !== LINK_FILE_VERSION)
    throw new Problem(
      400,
      "invalid-link-file",
      "Unrecognised link file",
      `${sourceName} must declare version "${LINK_FILE_VERSION}".`,
    );
  if (!Array.isArray(document.links))
    throw new Problem(
      400,
      "invalid-link-file",
      "Unrecognised link file",
      `${sourceName} must carry a "links" array.`,
    );
  const byWallet = new Map<string, IdentityLink>();
  for (const [index, entry] of document.links.entries()) {
    const at = `${sourceName} link ${String(index)}`;
    const raw = entry as { wallet?: unknown; privy_did?: unknown; account?: unknown };
    const wallet = String(raw.wallet ?? "").toLowerCase();
    const privyDid = String(raw.privy_did ?? "");
    const account = raw.account === undefined ? undefined : String(raw.account).toLowerCase();
    if (!ADDRESS_PATTERN.test(wallet))
      throw new Problem(
        400,
        "invalid-link-file",
        "Invalid wallet",
        `${at} has no 20-byte wallet address.`,
      );
    if (!DID_PATTERN.test(privyDid))
      throw new Problem(
        400,
        "invalid-link-file",
        "Invalid Privy DID",
        `${at} has no Privy DID of the form did:privy:<id>.`,
      );
    if (account !== undefined && !ADDRESS_PATTERN.test(account))
      throw new Problem(
        400,
        "invalid-link-file",
        "Invalid account",
        `${at} pins an account that is not a 20-byte address.`,
      );
    const existing = byWallet.get(wallet);
    if (existing && existing.privyDid !== privyDid)
      throw new Problem(
        409,
        "invalid-link-file",
        "Conflicting link",
        `${at} maps ${wallet} to ${privyDid}, but an earlier entry maps it to ${existing.privyDid}. One wallet cannot belong to two identities.`,
      );
    byWallet.set(wallet, { wallet, privyDid, account });
  }
  return { byWallet };
}

export async function loadLinkFile(path: string): Promise<LinkTable> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Problem(
      400,
      "invalid-link-file",
      "Unreadable link file",
      `${path} could not be read as JSON (${error instanceof Error ? error.message : "unknown error"}).`,
    );
  }
  return parseLinkFile(parsed, path);
}

export type ResolvedIdentity = {
  readonly privyDid: string;
  /** The `mandate_v2.users.id` to use: an existing row's id, or the preserved legacy id. */
  readonly userId: string;
  /** True when this run has to insert the user row. */
  readonly create: boolean;
  /** The wallet whose funds migrated strategies spend, unless a strategy pins its own. */
  readonly account: string | undefined;
};

/**
 * Decide who a legacy user is here, and which wallet their strategies spend from.
 *
 * When a Privy DID already exists in `mandate_v2` the migrated drafts attach to THAT user id,
 * not to the legacy one. Someone who signed up here before the migration ran must not end up
 * with two tenancies, one holding their history and one holding their login.
 */
export function resolveIdentity(
  user: LegacyUser,
  links: LinkTable,
  existingUsersByDid: ReadonlyMap<string, string>,
): ResolvedIdentity {
  const subject = `app_user ${user.id}`;
  const onBase = user.wallets.filter((wallet) => wallet.chainId === BASE_CAIP2);
  const matched = onBase
    .map((wallet) => links.byWallet.get(wallet.address))
    .filter((link): link is IdentityLink => link !== undefined);
  if (matched.length === 0)
    throw new Refused(
      issue(
        "identity.unlinked",
        subject,
        `None of this user's ${String(onBase.length)} Base wallets appears in the link file, so there is no identity to attach their strategies to.`,
      ),
    );
  const dids = [...new Set(matched.map((link) => link.privyDid))];
  const only = dids[0];
  if (dids.length > 1 || only === undefined)
    throw new Refused(
      issue(
        "identity.did-conflict",
        subject,
        `This user's wallets map to ${dids.length} different Privy identities (${dids.join(", ")}). Merging two tenancies into one is an operator decision, not a migration default.`,
      ),
    );
  const existing = existingUsersByDid.get(only);
  const pinned = matched.find((link) => link.account !== undefined)?.account;
  return {
    privyDid: only,
    userId: existing ?? user.id,
    create: existing === undefined,
    account: pinned ?? defaultAccount(onBase),
  };
}

/**
 * The wallet a migrated strategy spends from when nothing else names one.
 *
 * A Base Account is preferred because it is the wallet kind that can hold a spend permission
 * at all; an EOA cannot. Where the choice is genuinely ambiguous this returns nothing and the
 * caller refuses, because `drafts.account` is inside the artifact digest and the confirm
 * message — guessing it wrong produces a card the user's wallet cannot sign, discovered only
 * when they try.
 */
function defaultAccount(onBase: LegacyUser["wallets"]): string | undefined {
  const accounts = onBase.filter((wallet) => wallet.kind === "base_account");
  if (accounts.length === 1) return accounts[0]?.address;
  if (accounts.length > 1) return undefined;
  return onBase.length === 1 ? onBase[0]?.address : undefined;
}

/** The account a specific strategy should spend from, or a refusal naming why it is unclear. */
export function resolveAccount(
  strategyAccount: string | undefined,
  identity: ResolvedIdentity,
  subject: string,
): string {
  // An armed instance recorded which account it actually spent from; that beats any
  // inference from the wallet list, which may have grown since.
  const account = strategyAccount ?? identity.account;
  if (!account)
    throw new Refused(
      issue(
        "identity.account-ambiguous",
        subject,
        "The strategy was never armed and the user has no single Base Account, so which wallet it should spend from is a guess. Pin one with an `account` field in the link file.",
      ),
    );
  if (!ADDRESS_PATTERN.test(account))
    throw new Refused(
      issue(
        "identity.account-missing",
        subject,
        `The resolved account "${account}" is not a lowercase 20-byte address; mandate_v2.drafts.account will reject it.`,
      ),
    );
  return account;
}
