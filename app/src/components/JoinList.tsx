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

export function JoinList() {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const { state } = useAppContext();
  const [listName, setListName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function loadList() {
      if (!listId) return;
      const list = await getListById(listId);
      if (list) {
        setListName(list.name);
        // Suggest a slug based on the list name
        const suggested = list.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        setSlug(suggested);
      } else {
        setNotFound(true);
      }
      setLoading(false);
    }
    loadList();
  }, [listId]);

  const handleJoin = async () => {
    if (!slug.trim() || !listId || !state.authUser) return;

    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");

    if (state.userSlugs[cleanSlug]) {
      message.error(`You already have a list at "/${cleanSlug}"`);
      return;
    }

    setSubmitting(true);
    try {
      await setUserSlug(state.authUser.uid, cleanSlug, listId);
      navigate(`/${cleanSlug}`);
    } catch (error) {
      console.error("Failed to join list:", error);
      message.error("Failed to join list");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Container>
        <Header>
          <Title>Join List</Title>
        </Header>
        <Content>
          <Spin size="large" />
        </Content>
      </Container>
    );
  }

  if (notFound) {
    return (
      <Container>
        <Header>
          <Title>List Not Found</Title>
        </Header>
        <Content>
          <Description>This list doesn't exist or may have been deleted.</Description>
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
        <Title>Join List</Title>
      </Header>
      <Content>
        <ListName>{listName}</ListName>
        <Description>Choose a URL for this list</Description>
        <Form>
          <Label>Your URL</Label>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="groceries"
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
