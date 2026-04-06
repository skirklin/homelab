import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useBasePath } from "../RecipesRoutes";
import { Button, Spin, message } from "antd";
import styled from "styled-components";
import { doc, getDoc, updateDoc, arrayUnion } from "firebase/firestore";
import { useAuth } from "@kirkl/shared";
import { db } from "../backend";
import { boxConverter } from "../storage";

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

const BoxName = styled.h2`
  font-size: 1.5rem;
  margin: 0;
`;

const Description = styled.p`
  color: #666;
  margin: 0;
`;

const ButtonGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 300px;
`;

export default function JoinBox() {
  const { boxId } = useParams<{ boxId: string }>();
  const navigate = useNavigate();
  const basePath = useBasePath();
  const { user } = useAuth();
  const [boxName, setBoxName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function loadBox() {
      if (!boxId) return;
      try {
        const boxRef = doc(db, "boxes", boxId).withConverter(boxConverter);
        const boxDoc = await getDoc(boxRef);
        if (boxDoc.exists()) {
          const box = boxDoc.data();
          setBoxName(box.data.name);
        } else {
          setNotFound(true);
        }
      } catch (error) {
        console.error("Failed to load box:", error);
        setNotFound(true);
      }
      setLoading(false);
    }
    loadBox();
  }, [boxId]);

  const handleJoin = async () => {
    if (!boxId || !user) return;

    setSubmitting(true);
    try {
      const boxRef = doc(db, "boxes", boxId);
      const userRef = doc(db, "users", user.uid);

      // Add user as owner and subscriber of the box
      await updateDoc(boxRef, {
        owners: arrayUnion(user.uid),
        subscribers: arrayUnion(user.uid)
      });

      // Add box to user's boxes
      await updateDoc(userRef, {
        boxes: arrayUnion(boxRef)
      });

      message.success("Box added to your collection!");
      navigate(`${basePath}/boxes/${boxId}`);
    } catch (error) {
      console.error("Failed to join box:", error);
      message.error("Failed to join box. You may not have permission.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Container>
        <Header>
          <Title>Join Box</Title>
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
          <Title>Box Not Found</Title>
        </Header>
        <Content>
          <Description>This box doesn't exist or may have been deleted.</Description>
          <Button type="primary" onClick={() => navigate(".")}>
            Go Home
          </Button>
        </Content>
      </Container>
    );
  }

  return (
    <Container>
      <Header>
        <Title>Join Box</Title>
      </Header>
      <Content>
        <BoxName>{boxName}</BoxName>
        <Description>Add this recipe box to your collection?</Description>
        <ButtonGroup>
          <Button
            type="primary"
            size="large"
            onClick={handleJoin}
            loading={submitting}
          >
            Add to My Boxes
          </Button>
          <Button onClick={() => navigate(".")}>
            Cancel
          </Button>
        </ButtonGroup>
      </Content>
    </Container>
  );
}
