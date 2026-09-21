"use client";

import React from "react";

/** Catches render-time errors in any child view and offers a retry. */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error("Silvestar UI error:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ borderColor: "var(--err)" }}>
          <h2>⚠ Something went wrong</h2>
          <div className="hint">{this.state.error.message}</div>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
