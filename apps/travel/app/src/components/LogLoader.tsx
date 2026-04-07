import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Spin, Button, Empty } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { PageContainer, useAuth } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { getOrCreateUserLog } from "../pocketbase";

const Center = styled(PageContainer)`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 16px;
`;

/**
 * Auto-loads the user's travel log (creating one if needed).
 * No slug in the URL — just loads the first available log.
 */
export function LogLoader() {
  const { state, setCurrentLog } = useTravelContext();
  const { user } = useAuth();

  // Auto-load first slug
  useEffect(() => {
    const slugs = Object.values(state.userSlugs);
    if (slugs.length > 0 && state.log === null) {
      setCurrentLog(slugs[0]);
    }
  }, [state.userSlugs, state.log, setCurrentLog]);

  // Slugs not loaded yet
  if (!state.slugsLoaded) {
    return <Center><Spin size="large" /></Center>;
  }

  // No travel log exists — offer to create one
  if (Object.keys(state.userSlugs).length === 0) {
    const handleCreate = async () => {
      if (user) await getOrCreateUserLog(user.uid);
    };
    return (
      <Center>
        <Empty description="No travel logs yet">
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            Create Travel Log
          </Button>
        </Empty>
      </Center>
    );
  }

  // Log loading
  if (!state.log) {
    return <Center><Spin size="large" /></Center>;
  }

  return <Outlet />;
}
