import { type Hex, Problem } from "@mandate/contracts";
import { InvalidAuthTokenError, PrivyClient, type VerifyAccessTokenResponse } from "@privy-io/node";

export type AuthenticatedUser = { privyDid: string; sessionId: string; wallets: Hex[] };
export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<AuthenticatedUser>;
}
// Narrow read-only capabilities: authentication cannot sign or submit transactions.
export interface PrivyReader {
  verify(token: string): Promise<VerifyAccessTokenResponse>;
  user(id: string): Promise<{
    id: string;
    linked_accounts: ReadonlyArray<{
      type: string;
      address?: string;
      chain_type?: string;
    }>;
  }>;
}

export function privyReader(appId: string, appSecret: string): PrivyReader {
  const client = new PrivyClient({ appId, appSecret, timeout: 5000, maxRetries: 1 });
  return {
    verify: (token) => client.utils().auth().verifyAccessToken(token),
    user: (id) => client.users()._get(id),
  };
}

export class PrivyAuthenticator implements Authenticator {
  constructor(
    private readonly appId: string,
    private readonly reader: PrivyReader,
  ) {}

  async authenticate(authorization: string | undefined): Promise<AuthenticatedUser> {
    const match = authorization?.match(
      /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i,
    );
    if (!authorization || !match?.[1] || authorization.length > 16384)
      throw Problem.unauthenticated();
    let claims: VerifyAccessTokenResponse;
    try {
      claims = await this.reader.verify(match[1]);
    } catch (error) {
      if (error instanceof InvalidAuthTokenError) throw Problem.unauthenticated();
      throw Problem.unavailable("Authentication verification is temporarily unavailable.");
    }
    if (
      claims.app_id !== this.appId ||
      claims.issuer !== "privy.io" ||
      claims.expiration <= Date.now() / 1000 ||
      claims.issued_at > Date.now() / 1000 + 60 ||
      !/^did:privy:[A-Za-z0-9]+$/.test(claims.user_id) ||
      !claims.session_id
    ) {
      throw Problem.unauthenticated();
    }
    let user: Awaited<ReturnType<PrivyReader["user"]>>;
    try {
      user = await this.reader.user(claims.user_id);
    } catch {
      throw Problem.unavailable("Your linked accounts could not be verified. Try again shortly.");
    }
    if (user.id !== claims.user_id) throw Problem.unauthenticated();
    const wallets = user.linked_accounts.flatMap((account) =>
      account.type === "wallet" &&
      account.chain_type === "ethereum" &&
      account.address &&
      /^0x[0-9a-fA-F]{40}$/.test(account.address)
        ? [account.address.toLowerCase() as Hex]
        : [],
    );
    return {
      privyDid: claims.user_id,
      sessionId: claims.session_id,
      wallets: [...new Set(wallets)],
    };
  }
}
