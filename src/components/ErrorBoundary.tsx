import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Rendered instead of children after a render error. */
  fallback: (reset: () => void) => ReactNode;
  /** Changing this value clears the error (e.g. new message content). */
  resetKey?: unknown;
  children: ReactNode;
}

/** Contains render failures (e.g. malformed model output) to the subtree that failed. */
export class ErrorBoundary extends Component<Props, { failed: boolean; resetKey: unknown }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: { failed: boolean; resetKey: unknown }) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Render error contained by ErrorBoundary:", error, info.componentStack);
  }

  reset = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? this.props.fallback(this.reset) : this.props.children;
  }
}
