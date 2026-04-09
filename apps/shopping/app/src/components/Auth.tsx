import { useState } from "react";
import { Button, Input } from "antd";
import { GoogleOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { getBackend, useFeedback } from "@kirkl/shared";

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: var(--space-lg);
`;

const Title = styled.h1`
  font-size: var(--font-size-2xl);
  margin-bottom: var(--space-sm);
  color: var(--color-text);
`;

const Subtitle = styled.p`
  font-size: var(--font-size-base);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-xl);
`;

const DevLogin = styled.div`
  margin-top: var(--space-xl);
  padding: var(--space-md);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  max-width: 300px;
`;

const DevLabel = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-align: center;
`;

export function Auth() {
  const { message } = useFeedback();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    try {
      await getBackend().collection("users").authWithOAuth2({ provider: "google" });
    } catch (e) {
      console.error("Google sign-in failed:", e);
      message.error("Failed to sign in with Google");
    }
  };

  const handleEmailSignIn = async () => {
    if (!email || !password) return;
    setLoading(true);
    try {
      await getBackend().collection("users").authWithPassword(email, password);
    } catch {
      // Try creating the account
      try {
        await getBackend().collection("users").create({
          email,
          password,
          passwordConfirm: password,
        });
        await getBackend().collection("users").authWithPassword(email, password);
      } catch {
        message.error("Failed to sign in");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container>
      <Title>Shopping</Title>
      <Subtitle>A shared shopping list for you and your family</Subtitle>
      <Button
        type="primary"
        size="large"
        icon={<GoogleOutlined />}
        onClick={handleGoogleSignIn}
      >
        Sign in with Google
      </Button>

      {import.meta.env.DEV && (
        <DevLogin>
          <DevLabel>Development Login</DevLabel>
          <Input
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="email-input"
          />
          <Input.Password
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onPressEnter={handleEmailSignIn}
            data-testid="password-input"
          />
          <Button
            onClick={handleEmailSignIn}
            loading={loading}
            data-testid="email-sign-in"
          >
            Sign In
          </Button>
        </DevLogin>
      )}
    </Container>
  );
}
