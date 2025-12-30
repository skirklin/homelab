import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button, Result } from 'antd';
import styled from 'styled-components';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

const ErrorContainer = styled.div`
  padding: 24px;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
`;

/**
 * Error Boundary - catches JavaScript errors in child components.
 *
 * Without this, a single component error crashes the entire app.
 * With this, we show a friendly error message and the rest of the app keeps working.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <ComponentThatMightCrash />
 *   </ErrorBoundary>
 *
 * Note: Error boundaries must be class components - React doesn't support
 * error boundary hooks yet.
 */
class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  // Called when an error is thrown - updates state to show fallback UI
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  // Called after an error - good place to log errors
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error);
    console.error('Component stack:', errorInfo.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      // If a custom fallback was provided, use it
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI
      return (
        <ErrorContainer>
          <Result
            status="error"
            title="Something went wrong"
            subTitle={this.state.error?.message || 'An unexpected error occurred'}
            extra={[
              <Button key="retry" type="primary" onClick={this.handleReset}>
                Try Again
              </Button>,
              <Button key="home" onClick={() => window.location.href = '/'}>
                Go Home
              </Button>,
            ]}
          />
        </ErrorContainer>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
