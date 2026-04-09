import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useBasePath } from "../RecipesRoutes";
import { Button, Spin, Result } from "antd";
import styled from "styled-components";
import { getBackend, useFeedback } from "@kirkl/shared";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const Header = styled.header`
  padding: 16px;
  background: #2ca6a4;
  color: white;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
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
  target_type: "box" | "recipe";
  target_id: string;
}

export default function InviteRedeem() {
  const { message } = useFeedback();
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const basePath = useBasePath();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [result, setResult] = useState<RedeemResult | null>(null);

  useEffect(() => {
    async function redeem() {
      if (!code) {
        setErrorMsg("No invite code provided.");
        setStatus("error");
        return;
      }
      try {
        const pb = getBackend();
        const res = await pb.send("/api/sharing/redeem", {
          method: "POST",
          body: JSON.stringify({ code }),
          headers: { "Content-Type": "application/json" },
        });
        setResult(res as RedeemResult);
        setStatus("success");
      } catch (err: any) {
        const msg = err?.data?.message || err?.message || "Failed to redeem invite.";
        setErrorMsg(msg);
        setStatus("error");
      }
    }
    redeem();
  }, [code]);

  useEffect(() => {
    if (status !== "success" || !result) return;
    message.success("Invite accepted!");

    async function redirectToTarget() {
      let path: string;
      if (result!.target_type === "recipe") {
        // Recipes are nested under their box, so look up the box ID
        try {
          const pb = getBackend();
          const recipe = await pb.collection("recipes").getOne(result!.target_id);
          path = `${basePath}/boxes/${recipe.box}/recipes/${result!.target_id}`;
        } catch {
          // Fallback to home if we can't resolve the recipe's box
          path = `${basePath}/`;
        }
      } else {
        path = `${basePath}/boxes/${result!.target_id}`;
      }
      navigate(path, { replace: true });
    }

    const timer = setTimeout(redirectToTarget, 1000);
    return () => clearTimeout(timer);
  }, [status, result, navigate, basePath, message]);

  return (
    <Container>
      <Header>
        <Title>Accept Invite</Title>
      </Header>
      <Content>
        {status === "loading" && <Spin size="large" tip="Redeeming invite..." />}
        {status === "success" && (
          <Result
            status="success"
            title="Invite accepted!"
            subTitle="Redirecting you now..."
          />
        )}
        {status === "error" && (
          <Result
            status="error"
            title="Could not redeem invite"
            subTitle={errorMsg}
            extra={
              <Button type="primary" onClick={() => navigate(`${basePath}/`)}>
                Go Home
              </Button>
            }
          />
        )}
      </Content>
    </Container>
  );
}
