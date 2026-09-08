"use client";
import type { Call, Hex } from "@mandate/contracts";
import { ArrowUpRight, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { formatUnits } from "viem";
import { ApiError } from "../../lib/api";

type Permission = {
  status: string;
  typed_data: unknown;
  spender: string;
  allowance: string;
  period_secs: number;
  expires_at: string;
  approval_call?: Call;
  revocation_call?: Call;
  onchain_revocation_required?: boolean;
};
/**
 * Keyed by the API's RFC7807 `code`, so the copy tracks the backend's own vocabulary.
 *
 * Each says what is true for a strategy that is ALREADY SIGNED, which is the situation the user
 * is in by the time they reach this card. Switching the active wallet here would not help — the
 * instance is bound to the wallet that signed it — so the remedy for an unsupported wallet is a
 * new strategy, and saying otherwise would send someone in a circle.
 */
const SETTLED: Record<string, { title: string; detail: string }> = {
  "wallet-unsupported": {
    title: "This wallet can't approve automatic buying",
    detail:
      "Automatic buys need a Coinbase Smart Wallet. This strategy will keep recording signals you can act on yourself. To buy automatically, create a new strategy with a Coinbase Smart Wallet selected.",
  },
  "sell-permission-required": {
    title: "Selling can't run automatically",
    detail:
      "This strategy contains a sell rule, and automatic selling is not available yet. Its sells are recorded as signals for you to act on; its buys can still be approved on a strategy without sells.",
  },
  "manual-strategy": {
    title: "This strategy was signed as signal-only",
    detail: "Create a new strategy in automatic mode to have it buy for you.",
  },
  expired: {
    title: "This strategy has expired",
    detail: "Create a new one to keep going.",
  },
};

export function SpendingPermission({
  instance,
  call,
  sign,
  send,
  onChange,
}: {
  instance: string;
  call<T>(path: string, body?: unknown): Promise<T>;
  sign(data: unknown): Promise<Hex>;
  send(call: Call): Promise<Hex>;
  onChange(): void;
}) {
  const [permission, setPermission] = useState<Permission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hash, setHash] = useState<Hex | null>(null);
  const [revoking, setRevoking] = useState(false);
  /**
   * A refusal the user cannot retry their way out of.
   *
   * `prepare` rejects for reasons that are settled facts about this instance, not transient
   * failures: the wallet cannot hold a spend permission at all, the plan contains a sell, the
   * strategy has expired. Left in the generic error line these appeared above a "Review spending
   * approval" button that would return the same error forever, with nothing on screen naming a
   * remedy — so they replace the button instead of sitting above it.
   */
  const [blocked, setBlocked] = useState<{ title: string; detail: string } | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      const settled = e instanceof ApiError && e.code ? SETTLED[e.code] : undefined;
      if (settled) setBlocked(settled);
      else setError(e instanceof Error ? e.message : "Couldn't update spending approval.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="permission-card">
      <h3>
        <ShieldCheck size={17} />
        Automatic spending
      </h3>
      <p>
        Approve a budget from a compatible smart wallet. Your strategy's price rules and lifetime
        limits are enforced by Mandate.
      </p>
      {permission && (
        <dl>
          <div>
            <dt>
              Allowance per{" "}
              {permission.period_secs === 86400 ? "day" : `${permission.period_secs} seconds`}
            </dt>
            <dd>{formatUnits(BigInt(permission.allowance), 6)} USDC</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{new Date(permission.expires_at).toLocaleDateString()}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{permission.status}</dd>
          </div>
          <div>
            <dt>Spender</dt>
            <dd className="permission-address">{permission.spender}</dd>
          </div>
        </dl>
      )}
      {permission?.status === "prepared" && (
        <p>Funds pass through the spender wallet before the stock reaches your account.</p>
      )}
      {hash && (
        <a
          className="text-button"
          href={`https://basescan.org/tx/${hash}`}
          target="_blank"
          rel="noreferrer"
        >
          {revoking ? "Revocation transaction" : "Approval transaction"}
          <ArrowUpRight size={13} />
        </a>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {blocked && (
        <div className="permission-blocked" role="alert">
          <strong>{blocked.title}</strong>
          <span>{blocked.detail}</span>
        </div>
      )}
      <div className="permission-actions">
        {!permission && !blocked && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() =>
              run(async () =>
                setPermission(await call<Permission>("/v1/permissions/prepare", { instance })),
              )
            }
          >
            Review spending approval
          </button>
        )}
        {permission?.status === "prepared" && (
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const signature = await sign(permission.typed_data);
                const saved = await call<Permission>("/v1/permissions", { instance, signature });
                setPermission(saved);
                if (saved.approval_call) setHash(await send(saved.approval_call));
              })
            }
          >
            Sign & approve in wallet
          </button>
        )}
        {permission?.status === "signed" && permission.approval_call && !hash && (
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (permission.approval_call) setHash(await send(permission.approval_call));
              })
            }
          >
            Submit approval in wallet
          </button>
        )}
        {permission && !revoking && !["revoked", "expired"].includes(permission.status) && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setPermission(
                  await call<Permission>(`/v1/instances/${instance}/permission/activate`, {
                    enable_auto: true,
                  }),
                );
                onChange();
              })
            }
          >
            Check approval
          </button>
        )}
        {permission?.status === "active" && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const value = await call<Permission>(
                  `/v1/instances/${instance}/permission/revoke`,
                  {},
                );
                if (value.revocation_call && !revoking) {
                  setHash(await send(value.revocation_call));
                  setRevoking(true);
                }
                setPermission(value);
                onChange();
              })
            }
          >
            {revoking ? "Check revocation" : "Revoke in wallet"}
          </button>
        )}
        {busy && <Loader2 size={16} className="spin" />}
      </div>
      {permission?.status === "signed" && (
        <p>After the transaction confirms, check approval to enable automatic mode.</p>
      )}
    </section>
  );
}
