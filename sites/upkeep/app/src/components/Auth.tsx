import { useState } from "react";
import { GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { Button, Input, message } from "antd";
import { GoogleOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAuth, getBackend } from "@kirkl/shared";

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
  text-align: center;
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { auth } = getBackend();

  const handleGoogleSignIn = async () => {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  };

  const handleEmailSignIn = async () => {
    if (!email || !password) return;
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error: unknown) {
      // If user doesn't exist, create them (for emulator testing)
      if ((error as { code?: string }).code === "auth/user-not-found") {
        try {
          await createUserWithEmailAndPassword(auth, email, password);
        } catch {
          message.error("Failed to sign in");
        }
      } else {
        message.error("Failed to sign in");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container>
      <Title>Upkeep</Title>
      <Subtitle>Track recurring tasks and keep your home running smoothly</Subtitle>
      <Button
        type="primary"
        size="large"
        icon={<GoogleOutlined />}
        onClick={handleGoogleSignIn}
      >
        Sign in with Google
      </Button>

      {/* Dev/test login - only shown in development */}
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
