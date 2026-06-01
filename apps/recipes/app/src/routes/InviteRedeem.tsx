import { useState, useEffect, useRef } from "react";
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
  // Single-fire guard: React 18 StrictMode mounts the effect twice in dev
  // and the AbortController cleanup races with the POST already starting on
  // the server. The double-fire is functionally harmless (the hook is
  // idempotent post-866551e) but masks the underlying server-side bug —
  // pinning to one POST per code surfaces it so it can be fixed.
  //
  // KNOWN BUG (not yet fixed — 2026-05-31 investigation): with this guard,
  // the playwright `owner shares a box, second user redeems` test fails ~25%
  // of the time on a hot env. Failure: redeemer's `/boxes` page shows
  // "Your Boxes (0)" / "No data". DB query post-failure shows the failed
  // redeemer's `recipe_boxes` is `null`, even though the POST /api/sharing/redeem
  // returned 200 (so the page redirected to /boxes/<boxId> per line 94 of the
  // spec). Hook logs show `$app.save(user)` called with the correct value;
  // post-save `findRecordById` returns the byte-array shape of the JSON. But
  // SQLite stays at the pre-hook value. target.owners and the invite.redeemed
  // saves in the same hook DO persist; only the user.recipe_boxes write doesn't.
  // Verified NOT caused by:
  //   - Mirror race: even a fresh getOne after navigation sees null.
  //   - Timezone PATCH race: wrapping the user save in $app.runInTransaction
  //     made things WORSE (~70% failure), so it's not last-write-wins overwrite.
  // Likely cause: a goja write-side byte-array footgun (mirror of the read-side
  // one in sharing.pb.js header note (b)). When .set("recipe_boxes", jsArray)
  // is followed by $app.save on the `users` auth collection specifically, the
  // recipe_boxes write intermittently doesn't reach SQLite — even though
  // `updated` does bump. See git log + the brief from the parent for the
  // diagnostic path. Next agent should focus on:
  //   1. Why does target.owners (same shape, same hook, same txn) persist
  //      reliably while user.recipe_boxes doesn't?
  //   2. Try writing via raw `$app.db().newQuery(...).exec()` bypassing the
  //      record/save layer entirely.
  //   3. Try a different field name to rule out the field being special.
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!code) {
      setErrorMsg("No invite code provided.");
      setStatus("error");
      return;
    }
    if (firedFor.current === code) return;
    firedFor.current = code;
    // No AbortController: a single POST with no cleanup. The hook is
    // server-side idempotent for same-user retry, so even if the user
    // navigates away mid-flight, the server commits exactly once and the
    // next mount sees it.
    (async () => {
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
    })();
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
