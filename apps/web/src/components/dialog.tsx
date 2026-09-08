"use client";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

export function Dialog({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
  size,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose(): void;
  wide?: boolean;
  /**
   * "xl" is for a two-column body — a form beside a live summary, the way a checkout is laid
   * out. It supersedes `wide`, which stays for the single-column dialogs that already use it.
   */
  size?: "wide" | "xl";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${size === "xl" ? "dialog-xl" : size === "wide" || wide ? "dialog-wide" : ""}`}
      onCancel={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-head">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
