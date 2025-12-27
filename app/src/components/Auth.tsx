import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { Button } from "antd";
import { GoogleOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { auth } from "../backend";

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

export function Auth() {
  const handleGoogleSignIn = async () => {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  };

  return (
    <Container>
      <Title>Groceries</Title>
      <Subtitle>A shared shopping list for you and your family</Subtitle>
      <Button
        type="primary"
        size="large"
        icon={<GoogleOutlined />}
        onClick={handleGoogleSignIn}
      >
        Sign in with Google
      </Button>
    </Container>
  );
}
