"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  fallbackTitle?: string;
};

type State = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(_error: unknown, _errorInfo: ErrorInfo): void {
    // noop: boundary prevents entire app crash on isolated widget failures.
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-xl border border-rose-400/40 bg-rose-400/10 px-4 py-3 text-sm text-rose-200" role="alert">
          {this.props.fallbackTitle ?? "Something went wrong while rendering this section."}
        </div>
      );
    }
    return this.props.children;
  }
}
