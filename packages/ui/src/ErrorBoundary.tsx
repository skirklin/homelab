import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  /** Label shown in the error header (e.g. the module name) */
  label?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", this.props.label ?? "", error, info);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  reset = () => this.setState({ error: null, componentStack: null });

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          padding: 16,
          margin: 16,
          border: "1px solid #ffa39e",
          background: "#fff1f0",
          borderRadius: 8,
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 12,
          color: "#820014",
          maxWidth: "100%",
          overflowX: "auto",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
          {this.props.label ? `${this.props.label} crashed` : "Something went wrong"}
        </div>
        <div style={{ marginBottom: 8, wordBreak: "break-word" }}>
          {error.name}: {error.message}
        </div>
        <button
          onClick={this.reset}
          style={{
            padding: "4px 10px",
            marginBottom: 12,
            border: "1px solid #820014",
            background: "white",
            color: "#820014",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
        {error.stack && (
          <details style={{ marginBottom: 8 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Stack</summary>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 4 }}>
              {error.stack}
            </pre>
          </details>
        )}
        {componentStack && (
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Component stack</summary>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 4 }}>
              {componentStack}
            </pre>
          </details>
        )}
      </div>
    );
  }
}
