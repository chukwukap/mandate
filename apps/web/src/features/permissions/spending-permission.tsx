"use client";
import type { Call, Hex } from "@mandate/contracts";
import { ArrowUpRight, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { formatUnits } from "viem";

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
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update spending approval.");
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
      <div className="permission-actions">
        {!permission && (
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
