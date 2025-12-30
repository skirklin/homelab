import { useContext, useEffect, useState } from 'react';
import { Modal } from 'antd';
import styled from 'styled-components';
import { Context } from '../context';
import { getAppUserFromState } from '../state';
import { setLastSeenUpdateVersion } from '../firestore';

// Increment this when adding new updates
export const CURRENT_UPDATE_VERSION = 1;

const UpdateList = styled.ul`
  padding-left: var(--space-lg);
  margin: 0;
`;

const UpdateItem = styled.li`
  margin-bottom: var(--space-sm);
  line-height: 1.5;
`;

const UpdateTitle = styled.h4`
  margin: var(--space-md) 0 var(--space-xs) 0;
  color: var(--color-text);
  font-weight: 600;
  &:first-child {
    margin-top: 0;
  }
`;

function WhatsNew() {
  const [isOpen, setIsOpen] = useState(false);
  const { state } = useContext(Context);
  const user = getAppUserFromState(state);

  useEffect(() => {
    if (user && user.lastSeenUpdateVersion < CURRENT_UPDATE_VERSION) {
      const timer = setTimeout(() => setIsOpen(true), 500);
      return () => clearTimeout(timer);
    }
  }, [user]);

  const handleClose = () => {
    if (user) {
      setLastSeenUpdateVersion(user.id, CURRENT_UPDATE_VERSION);
    }
    setIsOpen(false);
  };

  if (!user) {
    return null;
  }

  return (
    <Modal
      title="What's New in Recipe Box"
      open={isOpen}
      onOk={handleClose}
      onCancel={handleClose}
      okText="Got it!"
      cancelButtonProps={{ style: { display: 'none' } }}
    >
      <UpdateTitle>Cooking Log</UpdateTitle>
      <UpdateList>
        <UpdateItem>
          Track when you make recipes with the new "I made it!" button
        </UpdateItem>
        <UpdateItem>
          Add notes about modifications or how it turned out
        </UpdateItem>
        <UpdateItem>
          See your cooking history on each recipe card
        </UpdateItem>
      </UpdateList>

      <UpdateTitle>AI Recipe Generation</UpdateTitle>
      <UpdateList>
        <UpdateItem>
          Generate new recipes from a description or ingredients using AI
        </UpdateItem>
        <UpdateItem>
          AI-powered descriptions and tags for imported recipes
        </UpdateItem>
      </UpdateList>

      <UpdateTitle>Bug Fixes</UpdateTitle>
      <UpdateList>
        <UpdateItem>
          Fixed apostrophes and special characters not displaying correctly
        </UpdateItem>
        <UpdateItem>
          Fixed recipe links not loading properly when shared
        </UpdateItem>
        <UpdateItem>
          Various UI improvements and polish
        </UpdateItem>
      </UpdateList>
    </Modal>
  );
}

export default WhatsNew;
