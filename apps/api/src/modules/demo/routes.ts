import type { Config } from "@mandate/config";
import { addressSchema, type Hex, Problem } from "@mandate/contracts";
import { USDC } from "@mandate/evm";
import type { FastifyInstance } from "fastify";
import { encodeAbiParameters, keccak256, numberToHex, pad, toHex } from "viem";
import { z } from "zod";
import { principal } from "../instances/http.js";

const fundInput = z.strictObject({ wallet: addressSchema.optional() });

/** Test USDC handed out per request, in whole dollars. Enough for several $50 strategies. */
const GRANT_USDC = 10_000n;
/** Gas float, in wei. The user's own wallet signs approve and swap, so it pays its own gas. */
const GRANT_WEI = 10n ** 18n;
/**
 * Above this the wallet is already usable and a second grant is refused.
 *
 * Idempotence matters more than generosity here: the button is on a page people revisit, and a
 * faucet that tops up on every click makes the balance shown in a recording unreproducible.
 */
const FUNDED_USDC = 1_000n;

/** USDC (FiatTokenV2_2) keeps balances in mapping slot 9 — the same slot the fork seed writes. */
function balanceSlot(wallet: Hex) {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [wallet, 9n]));
}

/**
 * Funding a demo wallet by writing chain state.
 *
 * `anvil_setStorageAt` and `anvil_setBalance` exist only on a fork; against a real node they
 * fail, which is the backstop behind the demo flag rather than the guard itself. The guard is
 * that this module is never registered unless the deployment says it is a demo.
 */
async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (!response.ok || body.error)
    throw Problem.unavailable("The demo chain did not accept the request. Try again shortly.");
  return body.result;
}

async function usdcBalance(url: string, wallet: Hex): Promise<bigint> {
  const result = (await rpc(url, "eth_call", [
    { to: USDC, data: `0x70a08231${wallet.slice(2).padStart(64, "0")}` },
    "latest",
  ])) as string;
  return BigInt(result ?? "0x0") / 1_000_000n;
}

/**
 * Registers `POST /v1/demo/fund`, the faucet behind the demo deployment's "Get test USDC".
 *
 * Only ever registered when `config.demo` is set, so a real deployment has no such route to
 * find. It funds the caller's OWN wallet and nothing else: a requested address is honoured only
 * when it is already among the session's verified linked wallets, so the body can choose BETWEEN
 * the caller's wallets but can never point the faucet at a stranger's.
 */
export async function registerDemo(app: FastifyInstance, config: Config) {
  app.post(
    "/v1/demo/fund",
    {
      schema: {
        tags: ["demo"],
        summary: "Fund the caller's wallet with test USDC on the demo fork",
      },
      // A faucet is the one route where repetition is the whole risk. Slower than the global
      // limit because a person clicks it once and a script would click it forever.
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    },
    async (request) => {
      const user = principal(request);
      // Which wallet, validated the way the portfolio route validates it. The client asks for
      // its embedded wallet by name because that is the account strategies trade from, and a
      // user who has also connected an external wallet would otherwise be funded on the wrong
      // one — test USDC in a wallet no strategy spends from looks exactly like a broken faucet.
      const asked = fundInput.safeParse(request.body ?? {});
      if (!asked.success)
        throw new Problem(
          400,
          "invalid-wallet",
          "Invalid wallet",
          "Wallet must be a 0x-prefixed 40-character address.",
        );
      const requested = asked.data.wallet?.toLowerCase();
      const wallet = requested
        ? user.wallets.find((w) => w.toLowerCase() === requested)
        : user.wallets[0];
      if (!wallet) {
        throw requested
          ? new Problem(
              403,
              "wallet-not-linked",
              "Wallet not linked",
              "That wallet is not linked to your account.",
            )
          : new Problem(
              409,
              "no-wallet",
              "No wallet linked",
              "Sign in with a wallet before requesting test funds.",
            );
      }
      const held = await usdcBalance(config.rpcUrl, wallet);
      if (held >= FUNDED_USDC)
        return { wallet, usdc: held.toString(), funded: false, notice: ALREADY_FUNDED };
      await rpc(config.rpcUrl, "anvil_setStorageAt", [
        USDC,
        balanceSlot(wallet),
        pad(toHex(GRANT_USDC * 1_000_000n), { size: 32 }),
      ]);
      // Gas, not decoration. The embedded wallet signs its own approve and swap now, so a wallet
      // with USDC and no ETH funds a strategy that can never execute one.
      await rpc(config.rpcUrl, "anvil_setBalance", [wallet, numberToHex(GRANT_WEI)]);
      await rpc(config.rpcUrl, "evm_mine", []);
      return {
        wallet,
        usdc: (await usdcBalance(config.rpcUrl, wallet)).toString(),
        funded: true,
        notice: FUNDED_NOTICE,
      };
    },
  );
}

const ALREADY_FUNDED =
  "This wallet already holds test USDC. Test funds exist only on the demo fork and have no value.";
const FUNDED_NOTICE =
  "Test USDC and test ETH were added on the demo fork. They are not real funds and exist only in this demo.";
