"use client";

import type { Hex } from "@mandate/contracts";
import {
  PrivyProvider,
  useCreateWallet,
  usePrivy,
  useSigners,
  useSignMessage,
  useWallets,
} from "@privy-io/react-auth";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { base } from "viem/chains";
import { type AutomationResult, type Me, request } from "../../lib/api";
import { useTheme } from "../../providers/theme-provider";

/**
 * Whether this account's wallet lets the app buy on its behalf.
 *
 * Read from `GET /v1/me`, which is the API's view of the delegation rather than Privy's: the
 * worker signs with what the API believes, so that is the value worth showing. `wallet` is the
 * embedded wallet the API will buy from, which is the same address the user deposits to.
 */
export type Automation = {
  supported: boolean;
  signerId: string | null;
  wallet: string | null;
  delegated: boolean;
  /** True until the first `/v1/me` read resolves, so a toggle is not drawn "off" by default. */
  loading: boolean;
};
export type Session = {
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  userId: string | null;
  wallets: string[];
  wallet: string | null;
  /** The Privy-managed wallet: the one users fund, and the one automatic buys come from. */
  embeddedWallet: string | null;
  createTradingWallet(): Promise<void>;
  selectWallet(value: string): void;
  login(): void;
  /** Resolves once the session is gone. `clean` is false when the SDK path failed and the
   *  session had to be cleared locally — the wallet extension may still think it is connected. */
  logout(): Promise<{ clean: boolean }>;
  token(): Promise<string | null>;
  sign(message: string): Promise<Hex>;
  automation: Automation;
  /** Delegates the embedded wallet to the app's signer, then tells the API to re-read it. */
  enableAutomation(): Promise<void>;
  /** Removes every signer from the embedded wallet, then tells the API to re-read it. */
  disableAutomation(): Promise<void>;
};
const unavailable = async (): Promise<never> => {
  throw new Error("Log in to continue.");
};
const NO_AUTOMATION: Automation = {
  supported: false,
  signerId: null,
  wallet: null,
  delegated: false,
  loading: false,
};
const offline: Session = {
  configured: false,
  ready: true,
  authenticated: false,
  userId: null,
  wallets: [],
  wallet: null,
  embeddedWallet: null,
  createTradingWallet: unavailable,
  selectWallet: () => {},
  login: () => {},
  logout: async () => ({ clean: true }),
  token: async () => null,
  sign: unavailable,
  automation: NO_AUTOMATION,
  enableAutomation: unavailable,
  disableAutomation: unavailable,
};
/**
 * Everything Privy persists in the browser, so a sign-out can be completed locally.
 *
 * Read out of the installed @privy-io/react-auth bundle rather than guessed. Clearing these is
 * what makes the session actually gone on reload; `logout()` normally does it, and this is what
 * runs when `logout()` cannot.
 */
const PRIVY_COOKIES = [
  "privy-token",
  "privy-id-token",
  "privy-refresh-token",
  "privy-session",
  "privy-ca-id",
  "privy-client-id",
];

/**
 * Sign out without asking the SDK's permission.
 *
 * `privy.logout()` talks to the wallet connectors on its way out, and an injected wallet that is
 * locked, removed, or simply not responding rejects — which left the user authenticated with a
 * button that did nothing. Clearing the stored session locally is not as tidy as a clean logout,
 * but the alternative is a user who cannot leave, and that is worse. Wrapped in try/catch
 * because storage access itself throws in some privacy modes.
 */
function forgetSession() {
  try {
    // The CookieStore API the lint prefers is absent in Safari and Firefox, and this is the
    // fallback that runs once the normal path has already failed — it cannot depend on the
    // better-supported thing being supported.
    // biome-ignore lint/suspicious/noDocumentCookie: expiring a cookie needs document.cookie
    for (const name of PRIVY_COOKIES) document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
  } catch {}
  for (const store of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      for (const key of Object.keys(store ?? {}))
        if (key.startsWith("privy")) store.removeItem(key);
    } catch {}
  }
}

const baseChain = {
  id: base.id,
  name: base.name,
  nativeCurrency: base.nativeCurrency,
  rpcUrls: base.rpcUrls,
  blockExplorers: base.blockExplorers,
  testnet: false,
};
const SessionContext = createContext<Session>(offline);
function Bridge({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  const { wallets, ready } = useWallets();
  const { addSigners, removeSigners } = useSigners();
  const { signMessage } = useSignMessage();
  const { createWallet } = useCreateWallet();
  const [selected, setSelected] = useState<string | null>(null);
  // The embedded wallet is the account: it is where deposits go and what the worker signs from,
  // so it wins over a linked external wallet unless the user has picked one on purpose.
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const wallet = wallets.find((w) => w.address === selected) ?? embedded ?? wallets[0];
  const authenticated = privy.authenticated;
  const address = wallet?.address ?? null;
  const [automation, setAutomation] = useState<Automation>({ ...NO_AUTOMATION, loading: true });
  // Refs, not dependencies: the hook hands back a fresh `getAccessToken` on renders that changed
  // nothing, and keying the /v1/me read on it would re-fetch the account on every one of them.
  const privyRef = useRef(privy);
  privyRef.current = privy;
  const walletRef = useRef(address);
  walletRef.current = address;
  const token = useCallback(() => privyRef.current.getAccessToken(), []);
  /**
   * The API's answer becomes the session's answer.
   *
   * The build-time signer id is preferred so the wallet is delegated to the signer this
   * deployment was configured for; the API's own id fills in when the env var is absent.
   */
  const applyMe = useCallback((me: Me) => {
    const signerId = process.env.NEXT_PUBLIC_PRIVY_KEY_QUORUM_ID || me.automation.signer_id || null;
    setAutomation({
      supported: me.automation.supported && Boolean(signerId),
      signerId,
      wallet: me.automation.wallet,
      delegated: me.automation.delegated,
      loading: false,
    });
  }, []);
  useEffect(() => {
    if (!authenticated || !address) {
      setAutomation({ ...NO_AUTOMATION, loading: false });
      return;
    }
    let active = true;
    setAutomation((current) => ({ ...current, loading: true }));
    void token()
      .then((bearer) => request<Me>("/v1/me", { token: bearer, wallet: address }))
      .then((me) => {
        if (active) applyMe(me);
      })
      // An unreadable /v1/me leaves automation "unsupported" rather than failing the session:
      // nothing else on screen depends on it, and the toggles say so instead of erroring.
      .catch(() => {
        if (active) setAutomation({ ...NO_AUTOMATION, loading: false });
      });
    return () => {
      active = false;
    };
  }, [authenticated, address, token, applyMe]);
  /**
   * Both directions end with the API re-reading Privy, because the API is what the worker
   * trusts. Privy alone succeeding would leave the strategies in manual mode with a wallet that
   * is already delegated — the worst of both.
   */
  const syncAutomation = useCallback(
    async (target: string, expected: boolean) => {
      const bearer = await token();
      // Privy's user record can briefly lag behind a successful signer update.
      // Confirm the observed state before reporting that automation changed.
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000));
        const result = await request<AutomationResult>("/v1/me/automation", {
          token: bearer,
          wallet: walletRef.current,
          body: { wallet: target },
        });
        setAutomation((current) => ({
          ...current,
          wallet: result.wallet,
          delegated: result.delegated,
          signerId: current.signerId ?? result.signer_id,
          loading: false,
        }));
        if (result.delegated === expected) return;
      }
      throw new Error("Your wallet update is still syncing. Please try again shortly.");
    },
    [token],
  );
  const enableAutomation = useCallback(async () => {
    const target = embedded?.address ?? automation.wallet;
    if (!target) throw new Error("Your wallet is still being created. Try again in a moment.");
    if (!automation.signerId)
      throw new Error("Automatic buying isn't available for this account yet.");
    await addSigners({ address: target, signers: [{ signerId: automation.signerId }] });
    await syncAutomation(target, true);
  }, [embedded?.address, automation.wallet, automation.signerId, addSigners, syncAutomation]);
  const disableAutomation = useCallback(async () => {
    const target = automation.wallet ?? embedded?.address;
    if (!target) return;
    await removeSigners({ address: target });
    await syncAutomation(target, false);
  }, [automation.wallet, embedded?.address, removeSigners, syncAutomation]);
  return (
    <SessionContext.Provider
      value={{
        configured: true,
        ready: privy.ready && ready,
        authenticated,
        userId: privy.user?.id ?? null,
        wallets: wallets.map((w) => w.address),
        wallet: address,
        embeddedWallet: embedded?.address ?? null,
        createTradingWallet: async () => {
          if (embedded) {
            setSelected(embedded.address);
            return;
          }
          const created = await createWallet();
          setSelected(created.address);
        },
        selectWallet: setSelected,
        // Wrapped rather than passed as bare references. These are read off the hook's return
        // value, and a method that turns out to need its receiver breaks silently and only at
        // the call site, which is the hardest possible place to notice it.
        login: () => privy.login(),
        /**
         * Signing out is not allowed to fail.
         *
         * The SDK's logout reaches out to the wallet connectors, and this app has a live example
         * of that rejecting — "Failed to connect to MetaMask" — which surfaced as a Sign out
         * button that did nothing at all. So the SDK gets its chance, and whatever it does, the
         * stored session is cleared afterwards and the caller is told what happened. `wallet`
         * tells the caller whether the wallet extension was left connected on its side.
         */
        logout: async () => {
          let clean = true;
          try {
            // Raced, not just awaited. The SDK clears its React auth state only AFTER its own
            // internal logout resolves, so a call that never settles leaves `authenticated`
            // true and the UI byte-for-byte unchanged — a button that is not slow but dead.
            // Losing the race is not an error; it just means we finish the job ourselves.
            await Promise.race([
              privy.logout(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("logout timed out")), 4000),
              ),
            ]);
          } catch {
            clean = false;
          }
          forgetSession();
          return { clean };
        },
        token,
        sign: async (message) => {
          if (!wallet) return unavailable();
          if (wallet.walletClientType === "privy") {
            // The strategy review already displays the exact message and asks for consent.
            // Keep signing inside that flow instead of opening a second modal underneath it.
            const { signature } = await signMessage(
              { message },
              { address: wallet.address, uiOptions: { showWalletUIs: false } },
            );
            return signature as Hex;
          }
          const provider = await wallet.getEthereumProvider();
          const bytes = new TextEncoder().encode(message);
          const encoded = `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          return (await provider.request({
            method: "personal_sign",
            params: [encoded, wallet.address],
          })) as Hex;
        },
        automation,
        enableAutomation,
        disableAutomation,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
export function Providers({ children }: { children: ReactNode }) {
  const { resolved } = useTheme();
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <SessionContext.Provider value={offline}>{children}</SessionContext.Provider>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: { theme: resolved, accentColor: "#31745C", walletChainType: "ethereum-only" },
        loginMethods: ["email", "wallet", "google"],
        // Every account gets an embedded wallet, even one that logged in with an external
        // wallet: it is the strategy account, and delegation only works on a wallet Privy holds.
        embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
        defaultChain: baseChain,
        supportedChains: [baseChain],
      }}
    >
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  );
}
export const useSession = () => useContext(SessionContext);
