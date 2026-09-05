"use client";
import { useTheme } from "../../providers/theme-provider";


import type { Call, Hex } from "@mandate/contracts";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { createContext, type ReactNode, useContext, useState } from "react";
import { base } from "viem/chains";

type Session = {
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  userId: string | null;
  wallets: string[];
  wallet: string | null;
  selectWallet(value: string): void;
  login(): void;
  logout(): Promise<void>;
  token(): Promise<string | null>;
  sign(message: string): Promise<Hex>;
  signPermission(data: unknown): Promise<Hex>;
  sendPermission(call: Call): Promise<Hex>;
};
const unavailable = async (): Promise<never> => {
  throw new Error("Connect a wallet to continue.");
};
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
  logout: async () => {},
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
        login: privy.login,
        logout: privy.logout,
        token: privy.getAccessToken,
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
          logout: async () => {},
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
