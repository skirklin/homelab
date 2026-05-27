import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useBasePath } from "../RecipesRoutes";
import { Button, Spin, Result } from "antd";
import styled from "styled-components";
import { getBackend, useFeedback } from "@kirkl/shared";

const Container = styled.div`
  min-height: 100vh;
  min-height: 100dvh;
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
    if (!code) {
      setErrorMsg("No invite code provided.");
      setStatus("error");
      return;
    }
    // PB's SendOptions extends RequestInit, so passing `signal` aborts the
    // underlying fetch on unmount. Redemption is idempotent server-side (a
    // re-click on the same link either succeeds again or returns the same
    // "already redeemed" path), so aborting is safe.
    const ac = new AbortController();
    (async () => {
      try {
        const pb = getBackend();
        const res = await pb.send("/api/sharing/redeem", {
          method: "POST",
          body: JSON.stringify({ code }),
          headers: { "Content-Type": "application/json" },
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        setResult(res as RedeemResult);
        setStatus("success");
      } catch (err: any) {
        if (ac.signal.aborted) return;
        const msg = err?.data?.message || err?.message || "Failed to redeem invite.";
        setErrorMsg(msg);
        setStatus("error");
      }
    })();
    return () => ac.abort();
  }, [code]);

  useEffect(() => {
    if (status !== "success" || !result) return;
    message.success("Invite accepted!");

    // Same AbortController treatment for the box-lookup leg — recipe-target
    // invites do a second PB read to resolve the parent box; on unmount we
    // want both the read and the post-read navigate to bail out cleanly.
    const ac = new AbortController();
    (async () => {
      let path: string;
      if (result!.target_type === "recipe") {
        try {
          const pb = getBackend();
          const recipe = await pb.collection("recipes").getOne(result!.target_id, {
            signal: ac.signal,
          });
          path = `${basePath}/boxes/${recipe.box}/recipes/${result!.target_id}`;
        } catch {
          // Aborted or fetch failed — fall back to home; the abort check
          // below stops us from yanking the user forward post-unmount.
          path = `${basePath}/`;
        }
      } else {
        path = `${basePath}/boxes/${result!.target_id}`;
      }
      if (ac.signal.aborted) return;
      navigate(path, { replace: true });
    })();
    return () => ac.abort();
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
