import { useState } from "react";
import styled from "styled-components";
import { Button, Form, Input, Divider } from "antd";
import { GoogleOutlined, MailOutlined } from "@ant-design/icons";
import { getBackend, useFeedback } from "@kirkl/shared";

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

export function Auth() {
  const { message } = useFeedback();
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setLoading(true);
    try {
      await getBackend().collection("users").authWithOAuth2({ provider: "google" });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to sign in";
      message.error(msg);
    }
    setLoading(false);
  };

  const handleEmailAuth = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      if (isSignUp) {
        await getBackend().collection("users").create({
          email: values.email,
          password: values.password,
          passwordConfirm: values.password,
        });
        await getBackend().collection("users").authWithPassword(values.email, values.password);
      } else {
        await getBackend().collection("users").authWithPassword(values.email, values.password);
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
          <Input prefix={<MailOutlined />} placeholder="Email" size="large" data-testid="email-input" />
        </Form.Item>

        <Form.Item
          name="password"
          rules={[
            { required: true, message: "Please enter your password" },
            { min: 6, message: "Password must be at least 6 characters" },
          ]}
        >
          <Input.Password placeholder="Password" size="large" data-testid="password-input" />
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block size="large" data-testid="email-sign-in">
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
