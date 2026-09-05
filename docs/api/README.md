# Mandate API v2

The API runs on Node.js. It supports Privy-authenticated strategy authoring and
permission preparation. It never signs or broadcasts transactions. The worker evaluates armed
instances. `execution_available` reports a live execution-enabled worker heartbeat,
not a guarantee that a particular instance can trade. Eligible arm requests renew
a 24-hour worker eligibility attestation.

## Authentication and request conventions

Obtain a current Privy access token with the React SDK's `getAccessToken()` and
send `Authorization: Bearer <token>`. The backend uses the pinned Node SDK to
verify the signature, issuer, app audience and expiry, then fetches linked
accounts. Its own database user ID is resolved from the verified Privy DID.

For wallet-specific operations, send `X-Mandate-Wallet: 0x...` using a linked
Ethereum wallet. This header may be omitted when exactly one wallet is linked.
Drafts retain the signing wallet even if the user's linked accounts later change.
Privy controls login/logout and token refresh; there are no custom nonce, login
or logout routes. Local JWT validation does not promise immediate logout revocation.

Browser origins must match APP_ORIGIN. Bearer tokens are the only authentication
transport; cookies are not accepted as authentication. CORS preflight allows
Authorization, Content-Type and X-Mandate-Wallet. Money is represented as decimal
strings; quote token amounts are raw integer strings. Timestamps are UTC ISO
strings except market `updated_at` and permission time fields, which use Unix seconds.

Errors use `application/problem+json` with `type`, `title`, `status`, `code`,
`detail` and `request_id`. Validation failures return 400; missing/invalid auth 401;
forbidden ownership/eligibility 403; unavailable owned resources 404; lifecycle
conflicts 409; compiler clarification 422; dependency unavailability 503.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Process liveness; public |
| GET | `/ready` | PostgreSQL schema/role and Base RPC readiness; public |
| GET | `/openapi.json` | Generated OpenAPI when API_DOCS=1 |
| GET | `/v1/me` | Verified user ID, Privy DID, linked wallets and jurisdiction |
| GET | `/v1/market` | Public configured catalogue and reference/DEX observations |
| POST | `/v1/market/quote` | Read-only exact-input quote for an eligible user |
| POST | `/v1/strategies/draft` | Persist a review artifact for structured or text input |
| POST | `/v1/strategies` | Verify exact saved review signature and create paused instance |
| GET | `/v1/strategies` | Owned instance summaries under `items` |
| GET | `/v1/instances` | Owned instance summaries under `items` |
| GET | `/v1/instances/:id` | Owned instance, signing account, plan, limits and review |
| POST | `/v1/instances/:id/arm` | Record intent to run; verify expiry and auto permission |
| POST | `/v1/instances/:id/pause` | Pause locally; does not revoke onchain authority |
| POST | `/v1/instances/:id/kill` | Terminal local stop; does not revoke onchain authority |
| GET | `/v1/instances/:id/evaluations` | Owned evaluation history under `items` |
| GET | `/v1/instances/:id/executions` | Owned execution history under `items` |
| POST | `/v1/permissions/prepare` | Persist or return identical permission payload |
| POST | `/v1/permissions` | Verify and save the permission signature; return approval call |
| GET | `/v1/instances/:id/permission` | Stored permission and its status |
| POST | `/v1/instances/:id/permission/activate` | Check actual onchain approval, optionally enable auto mode |
| POST | `/v1/instances/:id/permission/revoke` | Pause locally and return revocation call, or confirm chain revocation |

List/history query parameters: `limit` (1–100, default 50), optional `before`
(ISO timestamp) and `before_id` (UUID, requires before). Results sort newest first
by timestamp and ID. Use both fields returned in `next_page` for the following
request; `next_page: null` means there are no further records. Database timestamp
precision is milliseconds so the cursor round-trips without dropping equal-time rows.

## Authoring flow

POST a draft with `assets` (catalogue symbols), `caps`, `mode` (`manual` or `auto`),
and exactly one of `plan` or `prompt`. `name` is optional. Text authoring requires
both ANTHROPIC_API_KEY and ANTHROPIC_MODEL. The compiler is restricted to supplied
feeds and supported strategy operations; it asks for missing instructions rather
than choosing thresholds or investments.

`caps` contains `lifetime`, `per_order`, `per_period`, `period_secs`,
`max_orders_per_period`, `cooldown_secs`, `expires_at`, and optional `slippage_bps`
(default 50, maximum 500). USDC amounts allow six fractional digits and require
per_order ≤ per_period ≤ lifetime. Expiry must be between one minute and one year away.
The complete structured plan shape appears in OpenAPI and `packages/strategy`.

The draft returns `artifact_id`, `plan`, `envelope`, `card`, `render_text`,
`render_sha256`, `confirm_message` and `expires_at`. Display the review and sign
**the exact confirm_message** with the chosen wallet using personal_sign.
Submit `{artifact_id, signature}` to POST `/v1/strategies` before the draft expires
(30 minutes or strategy expiry, whichever is earlier). A successful response
includes the new `instance` ID. Draft consumption is atomic and cannot be replayed.
All instances start paused in manual mode; requesting auto mode in the draft does
not itself activate spending authority.

## Spending permissions

Automatic buy authorization currently requires an account supporting Coinbase
SpendPermissionManager with that manager installed as an owner. Privy embedded
wallets are not assumed to have this capability. Automatic sell permissions are
explicitly unsupported by this API version; manual sell plans and reverse sell
quotes are available. The worker records manual signals and executes authorized
automatic buys; it does not automatically submit sells.

1. POST `{instance}` to `/v1/permissions/prepare`. The returned typed_data uses
   EIP-712 on Base (8453). Use `viem.signTypedData` with the returned domain/types;
   allowance and salt are integer strings and can be converted to bigint.
2. Sign that stored payload. POST `{instance, signature}` to `/v1/permissions`.
   This saves status `signed` and returns `approval_call` (to/data/value/chain_id).
3. Submit the approval through the user's wallet. The API never broadcasts it.
4. After confirmation, POST `{enable_auto: true}` to
   `/v1/instances/:id/permission/activate`. Only actual onchain approval permits
   `active` status and automatic mode. Arm the instance separately.
5. To withdraw authority, call `/permission/revoke`, submit the returned call from
   the permission's account, and call the endpoint again after confirmation.
   `onchain_revocation_required: true` means authority has not yet been observed
   as revoked, even though the instance is paused locally.

Preparation retries reuse the exact stored salt, start, end and allowance. The
current model stores one USDC permission per instance. A revoked or expired
permission requires a fresh signed strategy. Never assume local pause/kill/logout
revokes a contract authorization.

## Market semantics and limits

Catalogue membership does not guarantee liquidity. Token metadata and positive
supply are checked against the configured address before using a reference feed.
Chainlink tokenized equity feeds already incorporate the share multiplier; the
API does not multiply their result a second time. Reference values may hold during
closed sessions or issuer pauses. The API does not certify session/pause status.

References older than 26 hours cannot support a quote. Quotes probe six Aerodrome
Slipstream tick spacings in the requested direction and choose the largest output
within 5% of the reference price. Market DEX observations use a 10-USDC buy probe;
user quotes must supply their own amount and slippage. A quote expires after 20
seconds and does not prove a wallet is allowed to transfer the tokens.

Unavailable observations contain `value: null`, `updated_at: 0`, `stale: true`.
Market refreshes are coalesced and cached for 15 seconds. RPC requests are batched
and paced with a bounded queue; the public RPC can still rate-limit requests.
Configure BASE_RPC_URL for the intended workload. The worker independently
checks fresh pricing, account transfer policies, simulations and authority before
executing; these read-only responses cannot substitute for those checks.
