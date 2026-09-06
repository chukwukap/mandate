import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MAX_ALLOWANCE, MAX_UINT48 } from "../../packages/contracts/src/index.js";
import { SPEND_MANAGER, USDC } from "../../packages/evm/src/permissions/index.js";
import {
  type ContractApi,
  call,
  commitStrategy,
  newIdentity,
  SPENDER_ADDRESS,
  startContractApi,
  type TestIdentity,
} from "./harness.js";
import { callSchema, parsed, permissionSchema, problemSchema } from "./schemas.js";

/**
 * The spend-permission surface: prepare, grant, read, activate, revoke.
 *
 * This is the only response in the API a wallet consumes directly. `typed_data` is handed
 * straight to `viem.signTypedData`, so every field of it is a byte of an EIP-712 digest: change
 * one and the user's signature verifies against a struct nobody authorized, and the failure
 * surfaces onchain as "invalid signature" after they have already paid gas.
 *
 * Two properties are asserted repeatedly because both have cost something before. The payload is
 * built once and reloaded verbatim — never rebuilt, because `start` is derived from a captured
 * `now` and crossing one second changes the digest. And the numbers in it are strings, because
 * `allowance` is uint160 and `salt` is uint256 and JSON has no integer that wide; a value rounded
 * through a float64 hashes differently.
 */

let api: ContractApi;
let alice: TestIdentity;

beforeAll(async () => {
  alice = newIdentity();
  api = await startContractApi({ identities: [alice] });
}, 60_000);

afterAll(async () => {
  await api.close();
}, 30_000);

async function autoInstance(identity: TestIdentity = alice) {
  return commitStrategy(api, identity, { mode: "auto" });
}

describe("POST /v1/permissions/prepare", () => {
  test("the response validates and the typed data is the EIP-712 struct the manager hashes", async () => {
    const committed = await autoInstance();
    const response = await call(api, {
      method: "POST",
      url: "/v1/permissions/prepare",
      token: alice.token,
      wallet: alice.wallet,
      payload: { instance: committed.instance },
    });
    expect(response.statusCode).toBe(200);
    const body = parsed(permissionSchema, response.json());
    expect(body.status).toBe("prepared");
    expect(body.instance).toBe(committed.instance);
    const { domain, message } = body.typed_data;
    // The verifying contract is Coinbase's SpendPermissionManager on Base. A different address
    // here produces a digest that manager will never honour.
    expect(domain.verifyingContract).toBe(SPEND_MANAGER);
    expect(domain.chainId).toBe(8453);
    expect(message.account).toBe(alice.wallet);
    expect(message.spender).toBe(SPENDER_ADDRESS);
    // A spend permission authorizes exactly one token, and this API only ever issues USDC.
    expect(message.token).toBe(USDC);
    expect(body.token).toBe(USDC);
    // The nine members in the exact order the struct is hashed in. Reordering them is a
    // different digest even though the JSON looks equivalent.
    expect(body.typed_data.types.SpendPermission.map((field) => field.name)).toEqual([
      "account",
      "spender",
      "token",
      "allowance",
      "period",
      "start",
      "end",
      "salt",
      "extraData",
    ]);
  });

  test("every wide integer crosses the wire as a string, never as a JSON number", async () => {
    const committed = await autoInstance();
    const raw = (
      await call(api, {
        method: "POST",
        url: "/v1/permissions/prepare",
        token: alice.token,
        wallet: alice.wallet,
        payload: { instance: committed.instance },
      })
    ).json<{ typed_data: { message: Record<string, unknown> }; allowance: unknown }>();
    for (const field of ["allowance", "salt"]) {
      expect(typeof raw.typed_data.message[field]).toBe("string");
    }
    expect(typeof raw.allowance).toBe("string");
    const body = parsed(permissionSchema, raw);
    // uint160 and uint48 are the widths the manager packs these into. A value above either
    // encodes fine in JSON and reverts onchain — the worst place to discover it, because the
    // user has already signed.
    expect(BigInt(body.typed_data.message.allowance)).toBeLessThanOrEqual(MAX_ALLOWANCE);
    expect(body.typed_data.message.end).toBeLessThanOrEqual(MAX_UINT48);
    expect(body.typed_data.message.period).toBeLessThanOrEqual(MAX_UINT48);
    // 20 USDC per period at 6 decimals. The worker recomputes units(per_period, 6) and refuses
    // to execute on any mismatch, so this string is a hard equality and not a display value.
    expect(body.allowance).toBe("20000000");
  });

  test("`start` is inclusive and before `end`, and `expires_at` is `end` rendered", async () => {
    const committed = await autoInstance();
    const body = parsed(
      permissionSchema,
      (
        await call(api, {
          method: "POST",
          url: "/v1/permissions/prepare",
          token: alice.token,
          wallet: alice.wallet,
          payload: { instance: committed.instance },
        })
      ).json(),
    );
    const { start, end } = body.typed_data.message;
    expect(start).toBeLessThan(end);
    // The permission's window is derived from the signed envelope with a floor, never a ceiling,
    // so it can never outlive the strategy it was signed for by even a millisecond.
    expect(Date.parse(body.expires_at)).toBe(end * 1000);
    expect(body.period_secs).toBe(body.typed_data.message.period);
  });

  test("preparing twice returns the same payload, byte for byte", async () => {
    const committed = await autoInstance();
    const prepare = () =>
      call(api, {
        method: "POST",
        url: "/v1/permissions/prepare",
        token: alice.token,
        wallet: alice.wallet,
        payload: { instance: committed.instance },
      });
    const first = parsed(permissionSchema, (await prepare()).json());
    const second = parsed(permissionSchema, (await prepare()).json());
    // Insert-once under a row lock. A second call must return the stored row untouched: a
    // rebuilt struct one second later moves `start`, which changes the digest, and the
    // signature the user is about to produce would then verify against nothing.
    expect(second.typed_data).toEqual(first.typed_data);
    expect(second.hash).toBe(first.hash);
    expect(second.id).toBe(first.id);
  });

  test("a manual strategy and a sell plan are both refused with their own 409 code", async () => {
    const manual = await commitStrategy(api, alice, { mode: "manual" });
    const manualResponse = await call(api, {
      method: "POST",
      url: "/v1/permissions/prepare",
      token: alice.token,
      wallet: alice.wallet,
      payload: { instance: manual.instance },
    });
    expect(manualResponse.statusCode).toBe(409);
    expect(parsed(problemSchema, manualResponse.json()).code).toBe("manual-strategy");

    // A USDC spend permission only lets the spender pull the quote asset, so an automatic sell
    // would produce a permission that verifies, activates, and then fails at execution time.
    const sellPlan = {
      params: [],
      nodes: [
        {
          id: "rich",
          op: "gt",
          args: [
            { kind: "feed", feed: "oracle:AAPLc" },
            { kind: "const", value: "300" },
          ],
        },
      ],
      machines: [
        {
          id: "exit",
          scope: "portfolio",
          initial: "hold",
          states: [
            {
              id: "hold",
              transitions: [
                {
                  when: "rich",
                  fires: "on_edge",
                  to: "hold",
                  actions: [
                    { action: "order", asset: 0, side: "sell", size: { unit: "base", value: "1" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const sell = await commitStrategy(api, alice, { mode: "auto", plan: sellPlan });
    const sellResponse = await call(api, {
      method: "POST",
      url: "/v1/permissions/prepare",
      token: alice.token,
      wallet: alice.wallet,
      payload: { instance: sell.instance },
    });
    expect(sellResponse.statusCode).toBe(409);
    const body = parsed(problemSchema, sellResponse.json());
    expect(body.code).toBe("sell-permission-required");
    // The detail offers the workaround rather than only stating the refusal.
    expect(body.detail).toContain("manual mode");
  });

  test("a wallet that cannot hold a spend permission is a 409, not a signed dead end", async () => {
    const eoa = newIdentity();
    // walletKind is re-read here at the moment it matters. The cached answer on
    // /v1/me/wallets is only ever used to decide what to *offer*: an owner is removable, and a
    // counterfactual account deploys on first use, so a capability read minutes ago is not a
    // fact about now.
    const api2 = await startContractApi({
      identities: [eoa],
      walletKinds: { [eoa.wallet.toLowerCase()]: "eoa" },
    });
    try {
      const committed = await commitStrategy(api2, eoa, { mode: "auto" });
      const response = await call(api2, {
        method: "POST",
        url: "/v1/permissions/prepare",
        token: eoa.token,
        wallet: eoa.wallet,
        payload: { instance: committed.instance },
      });
      expect(response.statusCode).toBe(409);
      const body = parsed(problemSchema, response.json());
      expect(body.code).toBe("wallet-unsupported");
      expect(body.detail).toContain("SpendPermissionManager");
      // Nothing was written: a refused prepare must not leave a row a later submit could load.
      expect(
        (
          await call(api2, {
            url: `/v1/instances/${committed.instance}/permission`,
            token: eoa.token,
          })
        ).statusCode,
      ).toBe(404);
      // The capability endpoint reports the same wallet honestly rather than contradicting it.
      const wallets = (await call(api2, { url: "/v1/me/wallets", token: eoa.token })).json<{
        items: { kind: string; can_authorize_spending: boolean }[];
      }>();
      expect(wallets.items[0]?.kind).toBe("eoa");
      expect(wallets.items[0]?.can_authorize_spending).toBe(false);
    } finally {
      await api2.close();
    }
  }, 60_000);
});

describe("POST /v1/permissions", () => {
  test("a verified signature returns the stored permission plus the approval call", async () => {
    const committed = await autoInstance();
    const prepared = parsed(
      permissionSchema,
      (
        await call(api, {
          method: "POST",
          url: "/v1/permissions/prepare",
          token: alice.token,
          wallet: alice.wallet,
          payload: { instance: committed.instance },
        })
      ).json(),
    );
    // The fixture chain verifies a permission signature against the digest of the exact stored
    // payload, so registering it here is the same act as the user signing that struct.
    const signature = `0x${"cd".repeat(65)}`;
    api.chain.grant({
      payload: {
        account: prepared.typed_data.message.account as `0x${string}`,
        spender: prepared.typed_data.message.spender as `0x${string}`,
        token: prepared.typed_data.message.token as `0x${string}`,
        allowance: prepared.typed_data.message.allowance,
        period: prepared.typed_data.message.period,
        start: prepared.typed_data.message.start,
        end: prepared.typed_data.message.end,
        salt: prepared.typed_data.message.salt,
        extraData: prepared.typed_data.message.extraData as `0x${string}`,
      },
      approved: false,
      revoked: false,
      signature: signature as `0x${string}`,
    });
    const response = await call(api, {
      method: "POST",
      url: "/v1/permissions",
      token: alice.token,
      wallet: alice.wallet,
      payload: { instance: committed.instance, signature },
    });
    expect(response.statusCode).toBe(200);
    const body = parsed(permissionSchema, response.json());
    expect(body.status).toBe("signed");
    // The payload the user signed is the payload that comes back. Nothing was rebuilt.
    expect(body.typed_data).toEqual(prepared.typed_data);
    expect(body.hash).toBe(prepared.hash);
    const raw = response.json<{ approval_call: unknown; onchain_approval_required: boolean }>();
    // A signature is not authority: the manager only honours an approved permission, so the
    // client still has to broadcast this call.
    expect(raw.onchain_approval_required).toBe(true);
    const approval = parsed(callSchema, raw.approval_call);
    expect(approval.to).toBe(SPEND_MANAGER);
    expect(approval.value).toBe("0");
    expect(approval.chain_id).toBe(8453);
  });

  test("a signature that does not verify is 400 invalid-signature, never 500", async () => {
    const committed = await autoInstance();
    await call(api, {
      method: "POST",
      url: "/v1/permissions/prepare",
      token: alice.token,
      wallet: alice.wallet,
      payload: { instance: committed.instance },
    });
    const response = await call(api, {
      method: "POST",
      url: "/v1/permissions",
      token: alice.token,
      wallet: alice.wallet,
      payload: { instance: committed.instance, signature: `0x${"11".repeat(65)}` },
    });
    expect(response.statusCode).toBe(400);
    const body = parsed(problemSchema, response.json());
    expect(body.code).toBe("invalid-signature");
    expect(body.detail).toContain("Sign the stored spending-permission payload");
  });
});

describe("GET /v1/instances/:id/permission", () => {
  test("reads back the stored permission unchanged", async () => {
    const committed = await autoInstance();
    const prepared = parsed(
      permissionSchema,
      (
        await call(api, {
          method: "POST",
          url: "/v1/permissions/prepare",
          token: alice.token,
          wallet: alice.wallet,
          payload: { instance: committed.instance },
        })
      ).json(),
    );
    const body = parsed(
      permissionSchema,
      (
        await call(api, {
          url: `/v1/instances/${committed.instance}/permission`,
          token: alice.token,
        })
      ).json(),
    );
    expect(body).toEqual(prepared);
  });

  test("an instance with no permission is 404, not an empty permission object", async () => {
    const manual = await commitStrategy(api, alice, { mode: "manual" });
    const response = await call(api, {
      url: `/v1/instances/${manual.instance}/permission`,
      token: alice.token,
    });
    expect(response.statusCode).toBe(404);
    expect(parsed(problemSchema, response.json()).code).toBe("not-found");
  });
});

describe("POST /v1/instances/:id/permission/activate", () => {
  test("an unapproved permission is 409 approval-pending, and stays unsigned-for-spending", async () => {
    const committed = await autoInstance();
    await call(api, {
      method: "POST",
      url: "/v1/permissions/prepare",
      token: alice.token,
      wallet: alice.wallet,
      payload: { instance: committed.instance },
    });
    const response = await call(api, {
      method: "POST",
      url: `/v1/instances/${committed.instance}/permission/activate`,
      token: alice.token,
      wallet: alice.wallet,
      payload: { enable_auto: true },
    });
    // Only observed chain state may promote a permission to "active". A signature stored
    // locally is not authority; the approval transaction is.
    expect(response.statusCode).toBe(409);
    const body = parsed(problemSchema, response.json());
    expect(body.code).toBe("approval-pending");
    expect(body.detail).toContain("Submit the approval call");
  });
});

describe("POST /v1/instances/:id/permission/revoke", () => {
  test("pauses locally, hands back a revocation call under both names, and says so", async () => {
    const committed = await autoInstance();
    await call(api, {
      method: "POST",
      url: "/v1/permissions/prepare",
      token: alice.token,
      wallet: alice.wallet,
      payload: { instance: committed.instance },
    });
    const response = await call(api, {
      method: "POST",
      url: `/v1/instances/${committed.instance}/permission/revoke`,
      token: alice.token,
    });
    expect(response.statusCode).toBe(200);
    const raw = response.json<{
      revocation_call: unknown;
      revoke_call: unknown;
      account: string;
      onchain_revocation_required: boolean;
    }>();
    parsed(permissionSchema, raw);
    const call1 = parsed(callSchema, raw.revocation_call);
    // `revocation_call` is the name apps/web reads and docs/api uses; `revoke_call` is the name
    // this endpoint shipped with. Emitting only the second silently disabled the web revoke
    // button — it paused the instance and never broadcast, leaving a live onchain permission
    // behind a UI that claimed otherwise. Both names must stay until apps/web is the only
    // client left.
    expect(raw.revoke_call).toEqual(raw.revocation_call);
    expect(call1.to).toBe(SPEND_MANAGER);
    expect(raw.onchain_revocation_required).toBe(true);
    expect(raw.account).toBe(alice.wallet);
    // Paused first, chain read second: if the RPC is down the request fails with the instance
    // already paused, which is the fail-safe direction.
    const instance = (
      await call(api, { url: `/v1/instances/${committed.instance}`, token: alice.token })
    ).json<{ status: string }>();
    expect(["paused", "halted", "ended"]).toContain(instance.status);
  });

  test("revocation is reachable without the signing wallet and without eligibility", async () => {
    const committed = await autoInstance();
    await call(api, {
      method: "POST",
      url: "/v1/permissions/prepare",
      token: alice.token,
      wallet: alice.wallet,
      payload: { instance: committed.instance },
    });
    const response = await call(api, {
      method: "POST",
      url: `/v1/instances/${committed.instance}/permission/revoke`,
      token: alice.token,
      // A jurisdiction the product is not offered in, and no X-Mandate-Wallet header.
      remoteAddress: "127.0.0.1",
      headers: { "cf-ipcountry": "US" },
    });
    // Withdrawing onchain authority is deliberately not gated on requireEligible or
    // requireAccount. Making this "consistent" with the other routes would strand users behind
    // a live permission they cannot stop.
    expect(response.statusCode).toBe(200);
    parsed(permissionSchema, response.json());
  });
});
