/**
 * Create the signer that lets the worker trade from users' Privy embedded wallets.
 *
 * A "signer" is a Privy key quorum: a P-256 public key registered with the app. A user grants
 * it access to their embedded wallet once (`addSigners` in the web app); afterwards a server
 * holding the matching private key can sign transactions from that wallet through Privy,
 * and never sees the wallet's own key. Run once per Privy app; keep the private key in the
 * worker's environment only.
 *
 *   PRIVY_APP_ID=… PRIVY_APP_SECRET=… bun packages/auth/scripts/create-signer.ts
 */
import { generateP256KeyPair, PrivyClient } from "@privy-io/node";

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;
if (!appId || !appSecret) throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET are required");

const client = new PrivyClient({ appId, appSecret });
const keys = await generateP256KeyPair();
const quorum = await client.keyQuorums().create({
  display_name: `Mandate executor ${new Date().toISOString().slice(0, 10)}`,
  authorization_threshold: 1,
  public_keys: [keys.publicKey],
});
console.log(`# Signer created for app ${appId}. Add these to the environment:`);
console.log(
  `PRIVY_KEY_QUORUM_ID=${quorum.id}                # api + web (NEXT_PUBLIC_PRIVY_KEY_QUORUM_ID)`,
);
console.log(`PRIVY_AUTHORIZATION_KEY=${keys.privateKey}   # worker only — never ship to a browser`);
