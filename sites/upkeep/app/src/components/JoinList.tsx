import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button, Input, Spin, message } from "antd";
import styled from "styled-components";
import { useAppContext } from "../context";
import { getListById, setUserSlug } from "../firestore";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const Header = styled.header`
  padding: var(--space-md);
  background: var(--color-primary);
  color: white;
`;

const Title = styled.h1`
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
`;

const Content = styled.main`
  flex: 1;
  padding: var(--space-xl);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-lg);
`;

const ListName = styled.h2`
  font-size: var(--font-size-xl);
  margin: 0;
`;

const Description = styled.p`
  color: var(--color-text-secondary);
  margin: 0;
`;

const Form = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  width: 100%;
  max-width: 300px;
`;

const Label = styled.label`
  font-weight: 500;
  color: var(--color-text-secondary);
  text-align: left;
`;

const ErrorBox = styled.div`
  background: #fff2f0;
  border: 1px solid #ffccc7;
  border-radius: var(--radius-md);
  padding: var(--space-md);
  color: #cf1322;
  text-align: left;
  width: 100%;
  max-width: 400px;
  word-break: break-word;
`;

export function JoinList() {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const { state } = useAppContext();
  const [listName, setListName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function loadList() {
      if (!listId) {
        setError("No list ID provided");
        setLoading(false);
        return;
      }

      if (!state.authUser) {
        // Wait for auth to be determined
        if (state.authUser === undefined) return;
        setError("You must be signed in to join a list");
        setLoading(false);
        return;
      }

      try {
        console.log("[JoinList] Loading list:", listId);
        const list = await getListById(listId);
        console.log("[JoinList] List result:", list);
        if (list) {
          setListName(list.name);
          // Suggest a slug based on the list name
          const suggested = list.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          setSlug(suggested);
        } else {
          setError("List not found. It may have been deleted.");
        }
      } catch (err) {
        console.error("[JoinList] Error loading list:", err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes("permission") || errorMessage.includes("Permission")) {
          setError(`Permission denied. Please make sure you're signed in. (${errorMessage})`);
        } else {
          setError(`Failed to load list: ${errorMessage}`);
        }
      } finally {
        setLoading(false);
      }
    }
    loadList();
  }, [listId, state.authUser]);

  const handleJoin = async () => {
    if (!slug.trim() || !listId || !state.authUser) return;

    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");

    if (state.userSlugs[cleanSlug]) {
      message.error(`You already have a list at "/${cleanSlug}"`);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      console.log("[JoinList] Joining list:", listId, "with slug:", cleanSlug);
      await setUserSlug(state.authUser.uid, cleanSlug, listId);
      console.log("[JoinList] Successfully joined list");
      navigate(`/${cleanSlug}`);
    } catch (err) {
      console.error("[JoinList] Failed to join list:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to join list: ${errorMessage}`);
      message.error("Failed to join list - see error below");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Container>
        <Header>
          <Title>Join Task List</Title>
        </Header>
        <Content>
          <Spin size="large" />
          <Description>Loading list...</Description>
        </Content>
      </Container>
    );
  }

  if (error && !listName) {
    return (
      <Container>
        <Header>
          <Title>Cannot Join List</Title>
        </Header>
        <Content>
          <ErrorBox>{error}</ErrorBox>
          <Description style={{ fontSize: "12px", marginTop: "8px" }}>
            List ID: {listId || "none"}
          </Description>
          <Button type="primary" onClick={() => navigate("/")}>
            Go to My Lists
          </Button>
        </Content>
      </Container>
    );
  }

  return (
    <Container>
      <Header>
        <Title>Join Task List</Title>
      </Header>
      <Content>
        <ListName>{listName}</ListName>
        <Description>Choose a URL for this list</Description>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Form>
          <Label>Your URL</Label>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="home"
            addonBefore="/"
            onPressEnter={handleJoin}
          />
          <Button
            type="primary"
            size="large"
            onClick={handleJoin}
            loading={submitting}
            disabled={!slug.trim()}
          >
            Add to My Lists
          </Button>
          <Button onClick={() => navigate("/")}>
            Cancel
          </Button>
        </Form>
      </Content>
    </Container>
  );
}
