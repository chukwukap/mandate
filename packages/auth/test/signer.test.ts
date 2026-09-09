import { expect, test } from "bun:test";
import type { PrivyReader } from "../src/privy/index.js";
import { embeddedWallet } from "../src/privy/signer.js";

const address = "0x1111111111111111111111111111111111111111";
function reader(delegated: boolean, signers: string[]): PrivyReader {
  return {
    verify: async () => {
      throw new Error("not used");
    },
    user: async () => ({
      id: "did:privy:test",
      linked_accounts: [
        {
          type: "wallet",
          chain_type: "ethereum",
          connector_type: "embedded",
          id: "wallet-id",
          address,
          delegated,
        },
      ],
    }),
    wallet: async () => ({ additional_signers: signers.map((signer_id) => ({ signer_id })) }),
  };
}

test("the configured quorum grants access even while the user flag is stale", async () => {
  expect(
    (await embeddedWallet(reader(false, ["our-quorum"]), "did:privy:test", address, "our-quorum"))
      ?.delegated,
  ).toBe(true);
});

test("removed signers revoke access even while the user flag is stale", async () => {
  expect(
    (await embeddedWallet(reader(true, []), "did:privy:test", address, "our-quorum"))?.delegated,
  ).toBe(false);
});

test("another app signer does not grant this quorum access", async () => {
  expect(
    (await embeddedWallet(reader(true, ["other-quorum"]), "did:privy:test", address, "our-quorum"))
      ?.delegated,
  ).toBe(false);
});

test("a failed signer lookup is not treated as consent", async () => {
  const source = reader(true, []);
  source.wallet = async () => {
    throw new Error("unavailable");
  };
  await expect(embeddedWallet(source, "did:privy:test", address, "our-quorum")).rejects.toThrow(
    "unavailable",
  );
});
