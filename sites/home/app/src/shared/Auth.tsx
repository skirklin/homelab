import { useState } from "react";
import styled from "styled-components";
import { Button, Form, Input, Divider, message } from "antd";
import { GoogleOutlined, MailOutlined } from "@ant-design/icons";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { getBackend } from "@kirkl/shared";

const SignInCard = styled.div`
  margin: 40px auto;
  max-width: 320px;
  padding: 24px;
  border-radius: 8px;
  box-shadow: 0 4px 12px 0 rgba(0, 0, 0, 0.15);
  background: white;
`;

const Title = styled.h1`
  text-align: center;
  margin-bottom: 24px;
  color: var(--color-primary);
`;

const googleProvider = new GoogleAuthProvider();

export function Auth() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    const { auth } = getBackend();
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to sign in";
      message.error(msg);
    }
    setLoading(false);
  };

  const handleEmailAuth = async (values: { email: string; password: string }) => {
    const { auth } = getBackend();
    setLoading(true);
    try {
      if (isSignUp) {
        await createUserWithEmailAndPassword(auth, values.email, values.password);
      } else {
        await signInWithEmailAndPassword(auth, values.email, values.password);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Authentication failed";
      message.error(msg);
    }
    setLoading(false);
  };

  return (
    <SignInCard>
      <Title>Home</Title>

      <Button
        icon={<GoogleOutlined />}
        onClick={handleGoogleSignIn}
        loading={loading}
        block
        size="large"
        style={{ marginBottom: 16 }}
      >
        Sign in with Google
      </Button>

      <Divider>or</Divider>

      <Form onFinish={handleEmailAuth} layout="vertical">
        <Form.Item
          name="email"
          rules={[
            { required: true, message: "Please enter your email" },
            { type: "email", message: "Please enter a valid email" },
          ]}
        >
          <Input prefix={<MailOutlined />} placeholder="Email" size="large" />
        </Form.Item>

        <Form.Item
          name="password"
          rules={[
            { required: true, message: "Please enter your password" },
            { min: 6, message: "Password must be at least 6 characters" },
          ]}
        >
          <Input.Password placeholder="Password" size="large" />
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block size="large">
            {isSignUp ? "Sign Up" : "Sign In"}
          </Button>
        </Form.Item>
      </Form>

      <Button type="link" onClick={() => setIsSignUp(!isSignUp)} block>
        {isSignUp ? "Already have an account? Sign In" : "Don't have an account? Sign Up"}
      </Button>
    </SignInCard>
  );
}
