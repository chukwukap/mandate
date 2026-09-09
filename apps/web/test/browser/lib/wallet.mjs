import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const FORK = "http://127.0.0.1:8545";
const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#36765a"/><path d="M8 22V12a4 4 0 0 1 8 0v10M16 22V12a4 4 0 0 1 8 0v10" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"/></svg>',
  );

/**
 * Attach an injected EIP-1193 wallet to a Playwright page before any app code runs.
 *
 * The page sees a provider object and an EIP-6963 announcement; every signature and every
 * transaction is performed here in Node with viem, so the private key never exists in the
 * browser. Returns the RPC log, which is the most useful artefact: it says exactly what Privy
 * and the app asked the wallet to do, in order.
 */
const attached = new WeakMap();

export async function attachWallet(page, privateKey) {
  // Once per page. exposeFunction refuses a name it has already registered, and a test that
  // signs out and back in on the same page would otherwise fail in the harness, not the app.
  const existing = attached.get(page);
  if (existing) {
    if (existing.key !== privateKey)
      throw new Error("attachWallet: a different key is already attached to this page");
    return existing.wallet;
  }
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({ account, chain: base, transport: http(FORK) });
  const log = [];
  await page.exposeFunction("__walletLog", (method) => {
    log.push(method);
  });
  await page.exposeFunction("__walletSign", async (method, params) => {
    if (method === "personal_sign") {
      const [message] = params; // hex-encoded UTF-8 per EIP-191 conventions
      return account.signMessage({ message: { raw: message } });
    }
    if (method === "eth_signTypedData_v4") {
      const [, json] = params;
      const typed = JSON.parse(json);
      const { EIP712Domain: _omit, ...types } = typed.types;
      return account.signTypedData({
        domain: typed.domain,
        types,
        primaryType: typed.primaryType,
        message: typed.message,
      });
    }
    if (method === "eth_sendTransaction") {
      const [tx] = params;
      return client.sendTransaction({
        to: tx.to,
        data: tx.data ?? "0x",
        value: tx.value ? BigInt(tx.value) : 0n,
      });
    }
    throw new Error(`unsupported sign method ${method}`);
  });
  await page.exposeFunction("__walletRpc", async (method, params) => {
    const r = await fetch(FORK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  });
  await page.addInitScript(
    ({ address, icon }) => {
      const listeners = {};
      const emit = (e, ...a) => {
        for (const f of listeners[e] ?? []) f(...a);
      };
      const provider = {
        isMandateTest: true,
        async request({ method, params }) {
          await window.__walletLog(method);
          switch (method) {
            case "eth_requestAccounts":
              emit("connect", { chainId: "0x2105" });
              return [address];
            case "eth_accounts":
              return [address];
            case "eth_chainId":
              return "0x2105";
            case "net_version":
              return "8453";
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
              return null;
            case "wallet_requestPermissions":
            case "wallet_getPermissions":
              return [{ parentCapability: "eth_accounts" }];
            case "personal_sign":
            case "eth_signTypedData_v4":
            case "eth_sendTransaction":
              return window.__walletSign(method, params);
            default:
              return window.__walletRpc(method, params ?? []);
          }
        },
        on(e, fn) {
          listeners[e] ??= [];
          listeners[e].push(fn);
          return provider;
        },
        removeListener(e, fn) {
          listeners[e] = (listeners[e] ?? []).filter((f) => f !== fn);
          return provider;
        },
      };
      window.ethereum = provider;
      const info = {
        uuid: "7c1b2f9e-0000-4000-8000-mandatetest1",
        name: "Mandate Test Wallet",
        icon,
        rdns: "test.mandate.wallet",
      };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: Object.freeze({ info, provider }),
          }),
        );
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    { address: account.address, icon: ICON },
  );
  const wallet = { address: account.address, log };
  attached.set(page, { key: privateKey, wallet });
  return wallet;
}
