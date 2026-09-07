"use client";
import { useCallback, useRef } from "react";
import { request } from "../../lib/api";
import type { useSession } from "./session-provider";
export function useAuthorizedApi(session: ReturnType<typeof useSession>) {
  const identity = `${session.userId ?? ""}:${session.wallet ?? ""}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const call = useCallback(
    async <T>(target: string, body?: unknown) => {
      const owner = identity;
      const auth = sessionRef.current;
      const token = await auth.token();
      if (currentIdentity.current !== owner) throw new Error("Wallet changed. Please try again.");
      const result = await request<T>(target, {
        token,
        wallet: auth.wallet,
        ...(body === undefined ? {} : { body }),
      });
      if (currentIdentity.current !== owner) throw new Error("Wallet changed. Please try again.");
      return result;
    },
    [identity],
  );
  return { call, identity, currentIdentity };
}
