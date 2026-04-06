import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Empty, Spin } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { PageContainer } from "@kirkl/shared";
import { useAuth } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { getOrCreateUserLog } from "../firestore";

const Container = styled(PageContainer)`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 16px;
`;

export function LogPicker() {
  const { state } = useTravelContext();
  const { user } = useAuth();
  const navigate = useNavigate();

  // Auto-navigate to first slug, or create one
  useEffect(() => {
    const slugs = Object.entries(state.userSlugs);
    if (slugs.length > 0) {
      navigate(`/travel/${slugs[0][0]}`, { replace: true });
    }
  }, [state.userSlugs, navigate]);

  if (!state.slugsLoaded || Object.keys(state.userSlugs).length > 0) {
    return (
      <Container>
        <Spin size="large" />
      </Container>
    );
  }

  const handleCreate = async () => {
    if (!user) return;
    await getOrCreateUserLog(user.uid);
    // Slug subscription will trigger navigation
  };

  return (
    <Container>
      <Empty description="No travel logs yet">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
          Create Travel Log
        </Button>
      </Empty>
    </Container>
  );
}
