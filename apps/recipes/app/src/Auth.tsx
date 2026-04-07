import React, { useState } from 'react';
import styled from 'styled-components';
import { Button, Form, Input, Divider, message } from 'antd';
import { GoogleOutlined, MailOutlined } from '@ant-design/icons';

import { useAuth, getBackend } from '@kirkl/shared';

const SignInCard = styled.div`
  margin: 40px auto;
  max-width: 320px;
  padding: 24px;
  border-radius: 8px;
  box-shadow: 0 4px 12px 0 rgba(0,0,0,0.15);
  background: white;
`

const Title = styled.h1`
  text-align: center;
  margin-bottom: 24px;
`

function Auth(props: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleGoogleSignIn = async () => {
    setSubmitting(true);
    try {
      const pb = getBackend();
      await pb.collection("users").authWithOAuth2({ provider: "google" });
    } catch (error: any) {
      message.error(error.message || 'Failed to sign in with Google');
    }
    setSubmitting(false);
  };

  const handleEmailAuth = async (values: { email: string; password: string }) => {
    setSubmitting(true);
    const pb = getBackend();
    try {
      if (isSignUp) {
        await pb.collection("users").create({
          email: values.email,
          password: values.password,
          passwordConfirm: values.password,
        });
        await pb.collection("users").authWithPassword(values.email, values.password);
      } else {
        await pb.collection("users").authWithPassword(values.email, values.password);
      }
    } catch (error: any) {
      message.error(error.message || 'Authentication failed');
    }
    setSubmitting(false);
  };

  // Still checking auth state - show nothing to avoid flash
  if (loading) {
    return null;
  }

  // Not logged in - show login form
  if (!user) {
    return (
      <SignInCard>
        <Title>Recipe Book</Title>

        <Button
          icon={<GoogleOutlined />}
          onClick={handleGoogleSignIn}
          loading={submitting}
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
              { required: true, message: 'Please enter your email' },
              { type: 'email', message: 'Please enter a valid email' }
            ]}
          >
            <Input
              prefix={<MailOutlined />}
              placeholder="Email"
              size="large"
            />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[
              { required: true, message: 'Please enter your password' },
              { min: 6, message: 'Password must be at least 6 characters' }
            ]}
          >
            <Input.Password
              placeholder="Password"
              size="large"
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={submitting}
              block
              size="large"
            >
              {isSignUp ? 'Sign Up' : 'Sign In'}
            </Button>
          </Form.Item>
        </Form>

        <Button type="link" onClick={() => setIsSignUp(!isSignUp)} block>
          {isSignUp ? 'Already have an account? Sign In' : "Don't have an account? Sign Up"}
        </Button>
      </SignInCard>
    );
  }

  // Logged in - show children
  return <>{props.children}</>;
}

export default Auth;
