import { useState } from "react";
import { Button, Form, Input, Divider } from "antd";
import { GoogleOutlined, MailOutlined } from "@ant-design/icons";
import { getBackend } from "./backend";
import { useFeedback } from "./useFeedback";

export function LoginScreen({ title = "Sign In" }: { title?: string }) {
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
    <div style={{ margin: "40px auto", maxWidth: 320, padding: 24, borderRadius: 8, boxShadow: "0 4px 12px 0 rgba(0,0,0,0.15)", background: "white" }}>
      <h1 style={{ textAlign: "center", marginBottom: 24 }}>{title}</h1>

      <Button icon={<GoogleOutlined />} onClick={handleGoogleSignIn} loading={loading} block size="large" style={{ marginBottom: 16 }}>
        Sign in with Google
      </Button>

      <Divider>or</Divider>

      <Form onFinish={handleEmailAuth} layout="vertical">
        <Form.Item name="email" rules={[{ required: true, message: "Email required" }, { type: "email" }]}>
          <Input prefix={<MailOutlined />} placeholder="Email" size="large" />
        </Form.Item>
        <Form.Item name="password" rules={[{ required: true, message: "Password required" }, { min: 6 }]}>
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
    </div>
  );
}
