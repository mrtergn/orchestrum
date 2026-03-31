"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { useModalLifecycle } from "@/lib/hooks/useModalLifecycle";

type ModalFrameProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  ariaLabel: string;
  overlayClassName?: string;
  containerClassName?: string;
  panelClassName?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  lockScroll?: boolean;
  panelProps?: Omit<HTMLAttributes<HTMLDivElement>, "children" | "role">;
};

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function ModalFrame({
  open,
  onClose,
  children,
  ariaLabel,
  overlayClassName,
  containerClassName,
  panelClassName,
  closeOnBackdrop = true,
  closeOnEscape = true,
  lockScroll = true,
  panelProps
}: ModalFrameProps) {
  useModalLifecycle({ open, onClose, closeOnEscape, lockScroll });

  if (!open) return null;

  const handleBackdropClick = () => {
    if (!closeOnBackdrop) return;
    onClose();
  };

  return (
    <div
      className={joinClasses("fixed inset-0", overlayClassName)}
      role="presentation"
      onClick={handleBackdropClick}
    >
      <div className={joinClasses("flex min-h-full justify-center", containerClassName)}>
        <div
          {...panelProps}
          className={joinClasses(
            "rounded-2xl border border-slate-800 bg-slate-950/95 shadow-2xl shadow-black/40",
            panelClassName,
            panelProps?.className
          )}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          onClick={(event) => {
            event.stopPropagation();
            panelProps?.onClick?.(event);
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
