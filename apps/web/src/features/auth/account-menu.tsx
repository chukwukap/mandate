"use client";

import { Check, ChevronDown, Copy, LogOut, Settings2, Wallet } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { shortAddress } from "../../lib/format";
import type { useSession } from "./session-provider";

type Session = ReturnType<typeof useSession>;

/**
 * The account control in the header.
 *
 * It used to be a button whose only behaviour was to navigate to Settings, which meant the one
 * thing people look for in a wallet chip — a way out — was two screens away and looked like it
 * was somewhere else entirely. A menu says what the options are before anything is chosen, and
 * keeps signing out a deliberate second click rather than something a stray tap can do.
 */
export function AccountMenu({
  session,
  onSignOut,
  onNavigate,
  onCopied,
}: {
  session: Session;
  onSignOut(): void;
  onNavigate(path: string): void;
  onCopied(message: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // Close on an outside click or Escape, and return focus to the trigger when Escape closes it —
  // otherwise keyboard users are dropped at the top of the document.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!session.authenticated)
    return (
      <button
        className="button wallet-button"
        type="button"
        onClick={() => session.login()}
        disabled={!session.ready}
      >
        <Wallet size={16} />
        <span>Log in</span>
      </button>
    );

  const address = session.wallet;
  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      onCopied("Address copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is refused in plenty of ordinary situations — an insecure origin, a
      // permission prompt the user dismissed. The address is on screen either way, so say so
      // rather than leaving a button that silently did nothing.
      onCopied("Couldn't copy — select the address to copy it manually.");
    }
  };

  return (
    <div className="account-menu" ref={wrapper}>
      <button
        ref={trigger}
        className={`button wallet-button connected ${open ? "open" : ""}`}
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!session.ready}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <Wallet size={16} />
        <span>{address ? shortAddress(address) : "Account"}</span>
        <ChevronDown size={14} className="account-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="account-popover" id={menuId} role="menu">
          <div className="account-identity">
            <span className="account-label">Signed in as</span>
            {/* The full address, not the truncated one: this is the place someone comes to
                check exactly which account they are about to act with. */}
            <code>{address ?? "No wallet connected"}</code>
          </div>
          {address && (
            <button type="button" role="menuitem" onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy address"}
            </button>
          )}
          {session.wallets.length > 1 && (
            <div className="account-wallets">
              <span className="account-label">Active wallet</span>
              {session.wallets.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === address}
                  onClick={() => {
                    session.selectWallet(value);
                    setOpen(false);
                  }}
                >
                  {value === address ? <Check size={15} /> : <span className="account-bullet" />}
                  {shortAddress(value)}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNavigate("/settings");
            }}
          >
            <Settings2 size={15} />
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            className="account-signout"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
