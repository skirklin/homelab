import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button, Spin, Result } from "antd";
import styled from "styled-components";
import { getBackend, useFeedback } from "@kirkl/shared";

const Container = styled.div`
  min-height: 60vh;
  display: flex;
  flex-direction: column;
`;

const Content = styled.main`
  flex: 1;
  padding: 48px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 24px;
`;

interface RedeemResult {
  success: boolean;
  target_type: string;
  target_id: string;
}

export function InviteRedeem() {
  const { message } = useFeedback();
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    async function redeem() {
      if (!code) {
        setErrorMsg("No invite code provided.");
        setStatus("error");
        return;
      }
      try {
        const pb = getBackend();
        await pb.send("/api/sharing/redeem", {
          method: "POST",
          body: JSON.stringify({ code }),
          headers: { "Content-Type": "application/json" },
        }) as RedeemResult;
        setStatus("success");
      } catch (err: unknown) {
        const e = err as { data?: { message?: string }; message?: string };
        setErrorMsg(e?.data?.message || e?.message || "Failed to redeem invite.");
        setStatus("error");
      }
    }
    redeem();
  }, [code]);

  useEffect(() => {
    if (status !== "success") return;
    message.success("Travel log added!");
    const timer = setTimeout(() => navigate("/travel", { replace: true }), 1000);
    return () => clearTimeout(timer);
  }, [status, navigate, message]);

  return (
    <Container>
      <Content>
        {status === "loading" && <Spin size="large" tip="Accepting invite..." />}
        {status === "success" && (
          <Result status="success" title="Invite accepted!" subTitle="Redirecting to your trips..." />
        )}
        {status === "error" && (
          <Result
            status="error"
            title="Could not redeem invite"
            subTitle={errorMsg}
            extra={
              <Button type="primary" onClick={() => navigate("/travel")}>Go to trips</Button>
            }
          />
        )}
      </Content>
    </Container>
  );
}
