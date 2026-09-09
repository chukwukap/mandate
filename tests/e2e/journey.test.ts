import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  type ContractApi,
  call,
  commitStrategy,
  newIdentity,
  startContractApi,
  type TestIdentity,
} from "../contract/harness.js";

/**
 * One user, start to finish, through the real HTTP surface.
 *
 * The contract suites next door each pin one endpoint's shape. Nothing was checking that the
 * endpoints compose: that the instance a draft produces is the one a permission attaches to,
 * that arming it changes what the list returns, and that a second user sees none of it. Those
 * are properties of the sequence, and a suite of per-endpoint tests can be entirely green while
 * the sequence is broken.
 *
 * This replaces a file called `__smoke.test.ts` that asserted nothing at all — it booted the app
 * and wrote two JSON dumps to an absolute path inside one machine's temp directory, so on any
 * other machine it verified nothing and littered.
 *
 * Everything outside the app is faked: the chain is `TestChain`, the database is PGlite, and
 * authentication is a stub. No network.
 */

let api: ContractApi;
let alice: TestIdentity;
let mallory: TestIdentity;

beforeAll(async () => {
  alice = newIdentity();
  mallory = newIdentity();
  api = await startContractApi({ identities: [alice, mallory] });
}, 30_000);

afterAll(async () => {
  await api?.close();
});

test("a strategy becomes an armed instance, and only its owner can see or move it", async () => {
  // 1. The catalogue is readable before anything is signed, and without a token at all.
  const market = await call(api, { url: "/v1/market" });
  expect(market.statusCode).toBe(200);
  expect(market.json<{ chain_id: number }>().chain_id).toBe(8453);

  // 2. Author and confirm. commitStrategy drafts, reads the rendered card back and confirms it,
  //    which is the sequence the UI performs.
  const committed = await commitStrategy(api, alice, { mode: "auto" });
  expect(committed.instance).toBeTruthy();

  // 3. The instance exists, belongs to Alice, and is not armed until she arms it.
  const listed = await call(api, {
    url: "/v1/instances",
    token: alice.token,
    wallet: alice.wallet,
  });
  expect(listed.statusCode).toBe(200);
  const rows = listed.json<{ items: { id: string; status: string }[] }>().items;
  const mine = rows.find((row) => row.id === committed.instance);
  expect(mine).toBeTruthy();
  // Committed but not running: a confirmed strategy waits for an explicit arm, so a signature
  // alone never starts spending.
  expect(mine?.status).toBe("paused");

  // 4. Mallory cannot see it. This is the property row-level security exists for, and it is
  //    asserted through HTTP rather than against the repository, because the gate that matters
  //    is the one a request actually passes through.
  const theirs = await call(api, {
    url: "/v1/instances",
    token: mallory.token,
    wallet: mallory.wallet,
  });
  expect(theirs.statusCode).toBe(200);
  const malloryRows = theirs.json<{ items: { id: string }[] }>().items;
  expect(malloryRows.some((row) => row.id === committed.instance)).toBe(false);

  // 5. Nor can she read it directly by naming its id. A list that filters and a detail route
  //    that does not is the classic way this leaks.
  const direct = await call(api, {
    url: `/v1/instances/${committed.instance}`,
    token: mallory.token,
    wallet: mallory.wallet,
  });
  expect([403, 404]).toContain(direct.statusCode);

  // 6. Nor move it. An owner check on read that is missing on write is worse than neither.
  const hijack = await call(api, {
    method: "POST",
    url: `/v1/instances/${committed.instance}/kill`,
    token: mallory.token,
    wallet: mallory.wallet,
  });
  expect([403, 404]).toContain(hijack.statusCode);

  // 7. Alice's own kill succeeds, and the state actually changes — the transition is the point,
  //    not the 200.
  const killed = await call(api, {
    method: "POST",
    url: `/v1/instances/${committed.instance}/kill`,
    token: alice.token,
    wallet: alice.wallet,
  });
  expect(killed.statusCode).toBe(200);

  const after = await call(api, {
    url: `/v1/instances/${committed.instance}`,
    token: alice.token,
    wallet: alice.wallet,
  });
  expect(after.statusCode).toBe(200);
  // "halted", not "ended". Both are terminal and they are not interchangeable: lifecycle.ts
  // writes "ended" only for a lapsed envelope, so a user pressing stop must not produce the
  // status that means the permission expired underneath them.
  expect(after.json<{ status: string }>().status).toBe("halted");
}, 60_000);

test("wallet automation activates only its owner's strategies and pauses on removal", async () => {
  let delegated = false;
  const direct = await startContractApi({
    identities: [alice, mallory],
    config: { PRIVY_KEY_QUORUM_ID: "test-signer" },
    wallets: {
      embedded: async (did, address) =>
        did === alice.privyDid && address === alice.wallet
          ? { id: "test-wallet", address: alice.wallet, delegated }
          : null,
    },
  });
  try {
    const committed = await commitStrategy(direct, alice, { mode: "auto" });
    const arm = () =>
      call(direct, {
        method: "POST",
        url: `/v1/instances/${committed.instance}/arm`,
        token: alice.token,
        wallet: alice.wallet,
      });
    expect((await arm()).statusCode).toBe(409);
    const foreign = await call(direct, {
      method: "POST",
      url: "/v1/me/automation",
      token: mallory.token,
      wallet: mallory.wallet,
      payload: { wallet: alice.wallet },
    });
    expect(foreign.statusCode).toBe(403);
    delegated = true;
    const sync = () =>
      call(direct, {
        method: "POST",
        url: "/v1/me/automation",
        token: alice.token,
        wallet: alice.wallet,
        payload: { wallet: alice.wallet },
      });
    expect((await sync()).statusCode).toBe(200);
    expect((await arm()).json()).toMatchObject({ mode: "auto", status: "armed" });
    delegated = false;
    expect((await sync()).statusCode).toBe(200);
    const paused = await call(direct, {
      url: `/v1/instances/${committed.instance}`,
      token: alice.token,
    });
    expect(paused.json()).toMatchObject({ mode: "manual", status: "paused" });
  } finally {
    await direct.close();
  }
}, 60_000);

test("an unauthenticated caller reaches the public market and nothing else", async () => {
  expect((await call(api, { url: "/v1/market" })).statusCode).toBe(200);
  expect((await call(api, { url: "/v1/instances" })).statusCode).toBe(401);
  expect((await call(api, { url: "/v1/me" })).statusCode).toBe(401);
  expect(
    (await call(api, { method: "POST", url: "/v1/permissions/prepare", payload: {} })).statusCode,
  ).toBe(401);
}, 30_000);
