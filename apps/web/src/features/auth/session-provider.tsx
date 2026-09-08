"use client";

import type { Call, Hex } from "@mandate/contracts";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { createContext, type ReactNode, useContext, useState } from "react";
import { base } from "viem/chains";
import { useTheme } from "../../providers/theme-provider";

type Session = {
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  userId: string | null;
  wallets: string[];
  wallet: string | null;
  selectWallet(value: string): void;
  login(): void;
  /** Resolves once the session is gone. `clean` is false when the SDK path failed and the
   *  session had to be cleared locally — the wallet extension may still think it is connected. */
  logout(): Promise<{ clean: boolean }>;
  token(): Promise<string | null>;
  sign(message: string): Promise<Hex>;
  signPermission(data: unknown): Promise<Hex>;
  sendPermission(call: Call): Promise<Hex>;
};
const unavailable = async (): Promise<never> => {
  throw new Error("Log in to continue.");
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
const SessionContext = createContext<Session>({
  configured: false,
  ready: true,
  authenticated: false,
  userId: null,
  wallets: [],
  wallet: null,
  selectWallet: () => {},
  login: () => {},
  logout: async () => ({ clean: true }),
  token: async () => null,
  sign: unavailable,
  signPermission: unavailable,
  sendPermission: unavailable,
});
function Bridge({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  const { wallets, ready } = useWallets();
  const [selected, setSelected] = useState<string | null>(null);
  const wallet = wallets.find((w) => w.address === selected) ?? wallets[0];
  return (
    <SessionContext.Provider
      value={{
        configured: true,
        ready: privy.ready && ready,
        authenticated: privy.authenticated,
        userId: privy.user?.id ?? null,
        wallets: wallets.map((w) => w.address),
        wallet: wallet?.address ?? null,
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
        token: () => privy.getAccessToken(),
        signPermission: async (data) => {
          if (!wallet) return unavailable();
          await wallet.switchChain(8453);
          const provider = await wallet.getEthereumProvider();
          return (await provider.request({
            method: "eth_signTypedData_v4",
            params: [wallet.address, JSON.stringify(data)],
          })) as Hex;
        },
        sendPermission: async (call) => {
          if (!wallet) return unavailable();
          if (
            call.chain_id !== 8453 ||
            call.value !== "0" ||
            call.to.toLowerCase() !== "0xf85210b21cc50302f477ba56686d2019dc9b67ad"
          )
            throw new Error("Unexpected permission transaction.");
          await wallet.switchChain(8453);
          const provider = await wallet.getEthereumProvider();
          return (await provider.request({
            method: "eth_sendTransaction",
            params: [{ from: wallet.address, to: call.to, data: call.data, value: "0x0" }],
          })) as Hex;
        },
        sign: async (message) => {
          if (!wallet) return unavailable();
          const provider = await wallet.getEthereumProvider();
          const bytes = new TextEncoder().encode(message);
          const encoded = `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          return (await provider.request({
            method: "personal_sign",
            params: [encoded, wallet.address],
          })) as Hex;
        },
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
export function Providers({ children }: { children: ReactNode }) {
  const { resolved } = useTheme();
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId)
    return (
      <SessionContext.Provider
        value={{
          configured: false,
          ready: true,
          authenticated: false,
          userId: null,
          wallets: [],
          wallet: null,
          selectWallet: () => {},
          login: () => {},
          logout: async () => ({ clean: true }),
          token: async () => null,
          sign: unavailable,
          signPermission: unavailable,
          sendPermission: unavailable,
        }}
      >
        {children}
      </SessionContext.Provider>
    );
  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: { theme: resolved, accentColor: "#31745C", walletChainType: "ethereum-only" },
        loginMethods: ["email", "wallet", "google"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: baseChain,
        supportedChains: [baseChain],
      }}
    >
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  );
}
export const useSession = () => useContext(SessionContext);
