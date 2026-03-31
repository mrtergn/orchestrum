"use client";

import { useEffect } from "react";

type UseModalLifecycleOptions = {
  open: boolean;
  onClose: () => void;
  closeOnEscape?: boolean;
  lockScroll?: boolean;
};

export function useModalLifecycle({
  open,
  onClose,
  closeOnEscape = true,
  lockScroll = true
}: UseModalLifecycleOptions) {
  useEffect(() => {
    if (!open || !lockScroll) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [lockScroll, open]);

  useEffect(() => {
    if (!open || !closeOnEscape) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeOnEscape, onClose, open]);
}
