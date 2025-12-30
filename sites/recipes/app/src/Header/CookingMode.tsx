import { useState, useEffect, useCallback, useContext } from 'react';
import styled from 'styled-components';
import { Button, Popover, Tooltip } from 'antd';
import { FireOutlined, FireFilled } from '@ant-design/icons';
import { Context } from '../context';
import { getAppUserFromState } from '../state';
import { setCookingModeSeen } from '../firestore';

const IconButton = styled(Button)<{ $active?: boolean; $highlight?: boolean }>`
  background-color: ${props => props.$active ? 'var(--color-accent)' : 'transparent'};
  color: ${props => props.$active ? 'white' : 'white'};
  border: none;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  transition: all 0.2s ease;
  ${props => props.$highlight && `
    animation: pulse 2s ease-in-out infinite;
  `}

  &:hover {
    color: white;
    background-color: ${props => props.$active ? 'var(--color-accent)' : 'rgba(255, 255, 255, 0.15)'};
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(233, 79, 55, 0.4); }
    50% { box-shadow: 0 0 0 8px rgba(233, 79, 55, 0); }
  }
`

const PopoverContent = styled.div`
  max-width: 220px;
`

const PopoverTitle = styled.div`
  font-weight: 600;
  margin-bottom: var(--space-xs);
`

const PopoverText = styled.p`
  margin: 0 0 var(--space-sm) 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`

function CookingMode() {
  const [wakeLock, setWakeLock] = useState<WakeLockSentinel | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [showPopover, setShowPopover] = useState(false);
  const { state } = useContext(Context);
  const user = getAppUserFromState(state);

  useEffect(() => {
    // Wake lock is nice-to-have, cooking mode works without it
    setIsSupported(true);
  }, []);

  // Show popover for users who haven't seen this feature
  useEffect(() => {
    if (user && !user.cookingModeSeen) {
      const timer = setTimeout(() => setShowPopover(true), 1000);
      return () => clearTimeout(timer);
    }
  }, [user]);

  const markAsSeen = useCallback(() => {
    if (user && !user.cookingModeSeen) {
      setCookingModeSeen(user.id);
    }
    setShowPopover(false);
  }, [user]);

  const enableCookingMode = useCallback(async () => {
    markAsSeen();
    setIsActive(true);
    document.body.classList.add('cooking-mode');

    // Try to acquire wake lock if supported
    if ('wakeLock' in navigator) {
      try {
        const lock = await navigator.wakeLock.request('screen');
        setWakeLock(lock);

        lock.addEventListener('release', () => {
          setWakeLock(null);
        });
      } catch (err) {
        console.warn('Wake Lock request failed:', err);
      }
    }
  }, [markAsSeen]);

  const disableCookingMode = useCallback(async () => {
    setIsActive(false);
    document.body.classList.remove('cooking-mode');

    if (wakeLock) {
      await wakeLock.release();
      setWakeLock(null);
    }
  }, [wakeLock]);

  // Re-acquire wake lock when page becomes visible again
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (isActive && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
        try {
          const lock = await navigator.wakeLock.request('screen');
          setWakeLock(lock);
          lock.addEventListener('release', () => setWakeLock(null));
        } catch (err) {
          console.warn('Wake Lock re-acquire failed:', err);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isActive]);

  // Clean up on unmount only
  useEffect(() => {
    return () => {
      document.body.classList.remove('cooking-mode');
    };
  }, []);

  // Release wake lock on unmount
  useEffect(() => {
    return () => {
      if (wakeLock) {
        wakeLock.release();
      }
    };
  }, [wakeLock]);

  if (!isSupported) {
    return null;
  }

  const shouldHighlight = !user?.cookingModeSeen && !isActive;

  const popoverContent = (
    <PopoverContent>
      <PopoverTitle>Cooking Mode</PopoverTitle>
      <PopoverText>
        Tap here to enable larger text and keep your screen on while you cook!
      </PopoverText>
      <Button size="small" type="primary" onClick={markAsSeen}>
        Got it
      </Button>
    </PopoverContent>
  );

  const button = (
    <IconButton
      $active={isActive}
      $highlight={shouldHighlight}
      icon={isActive ? <FireFilled /> : <FireOutlined />}
      onClick={isActive ? disableCookingMode : enableCookingMode}
    />
  );

  if (showPopover) {
    return (
      <Popover
        content={popoverContent}
        open={showPopover}
        placement="bottomRight"
        onOpenChange={(open) => !open && markAsSeen()}
      >
        {button}
      </Popover>
    );
  }

  return (
    <Tooltip title={isActive ? "Cooking mode on" : "Enable cooking mode"}>
      {button}
    </Tooltip>
  );
}

export default CookingMode;
