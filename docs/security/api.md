# API security boundaries

Privy access tokens establish a user identity, not permission to trade. The server
verifies the token with Privy's Node SDK, resolves its DID to a local user, and
fetches linked wallets before accepting a selected account. An identity token or
unverified wallet address cannot substitute for an access token. Tokens, app
secrets, signatures and request bodies are excluded from application logs.

The API accepts bearer authentication only. Browser origins are restricted to
APP_ORIGIN. The configured proxy must overwrite the country header; arbitrary
forwarded headers from direct clients are ignored. Country checks implement the
configured product allowlist and are not a KYC attestation.

Every tenant query uses a transaction-local user context. PostgreSQL policies
scope drafts, instances, permissions, evaluations and executions, and FORCE RLS
also covers table owners. Readiness rejects superuser/BYPASSRLS application roles.
Authentication identity lookup is available before tenant context and has no
public enumeration route. Use separate migration and application credentials.

A strategy's commitment binds its unique artifact ID, owner, wallet, plan,
limits, requested mode, review and expiry. Personal-sign verification uses the
stored review message. Database triggers forbid changing its signed contents;
atomic draft consumption prevents replay and concurrent duplicate creation.

Permission preparation persists a random salt and exact time bounds before the
wallet signs. Saving a signature creates `signed` status. Only a chain read proving
approval can activate it. Local pause, kill or logout never claims to revoke
contract authority. Revocation is confirmed only from onchain state. Strategy
conditions and lifetime/per-order limits require future worker enforcement;
the spending contract enforces its own token, period, allowance and time bounds.
Funds would pass through the configured spender during execution; this API does
not claim the full eventual flow is noncustodial.

The API contains no private spender keys, transaction sender or execution loop.
Quotes are indicative read-only simulations of venue pricing. They do not validate
a user's transfer-policy eligibility or certify that a reference feed is live
during a corporate action or closed session. The worker must independently
validate authority, fresh inputs, token policy, simulation and limits before
signing or sending anything. Automatic sell authorization remains unsupported.

SDK/RPC requests have bounded retries and timeouts; market refreshes coalesce,
and public RPC batching has a bounded queue. API request bodies are limited to
128 KiB, global requests are rate-limited, and drafting has a stricter limit.
Invalid inputs, missing prices, mismatched networks and expired authority fail
closed. Provider failures can reduce availability and never create fabricated
prices or successful transaction records.
