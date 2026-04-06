/**
 * Unified Settings page for the home app.
 * Consolidates settings from all embedded apps in one place.
 */

import { useState, useEffect } from "react";
import { Button, Segmented, message, Spin, Modal } from "antd";
import { BellOutlined, DeleteOutlined, ExperimentOutlined, CheckSquareOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { arrayRemove } from "firebase/firestore";
import { useAuth, getBackend, type NotificationMode, PageContainer } from "@kirkl/shared";

const Content = styled.div`
  padding: var(--space-lg);
  max-width: 600px;
  margin: 0 auto;
`;

const PageTitle = styled.h1`
  font-size: var(--font-size-xl);
  margin-bottom: var(--space-lg);
`;

const Section = styled.section`
  margin-bottom: var(--space-xl);
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
`;

const SectionIcon = styled.span`
  font-size: 20px;
  color: var(--color-primary);
`;

const SectionTitle = styled.h2`
  font-size: var(--font-size-lg);
  margin: 0;
`;

const SettingRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-md);
  background: var(--color-bg);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-sm);
`;

const SettingInfo = styled.div`
  flex: 1;
`;

const SettingLabel = styled.div`
  font-weight: 500;
`;

const SettingDescription = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-top: 2px;
`;

const TokenInfo = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

const TokenCount = styled.span<{ $warning?: boolean }>`
  font-weight: 500;
  color: ${props => props.$warning ? "var(--color-warning)" : "var(--color-text)"};
`;

const LoadingState = styled.div`
  display: flex;
  justify-content: center;
  padding: var(--space-xl);
`;

interface UserSettings {
  upkeepNotificationMode?: NotificationMode;
  fcmTokens?: string[];
}

const VALID_NOTIFICATION_MODES: NotificationMode[] = ["all", "subscribed", "off"];

function isValidNotificationMode(value: unknown): value is NotificationMode {
  return typeof value === "string" && VALID_NOTIFICATION_MODES.includes(value as NotificationMode);
}

function parseUserSettings(data: Record<string, unknown>): UserSettings {
  const settings: UserSettings = {};

  // Validate notification mode
  if (isValidNotificationMode(data.upkeepNotificationMode)) {
    settings.upkeepNotificationMode = data.upkeepNotificationMode;
  }

  // Validate fcmTokens array
  if (Array.isArray(data.fcmTokens) && data.fcmTokens.every(t => typeof t === "string")) {
    settings.fcmTokens = data.fcmTokens;
  }

  return settings;
}

export function Settings() {
  const { user } = useAuth();
  const { db } = getBackend();
  const [settings, setSettings] = useState<UserSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load user settings
  useEffect(() => {
    if (!user) return;

    const loadSettings = async () => {
      try {
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          setSettings(parseUserSettings(userSnap.data()));
        }
      } catch (err) {
        console.error("Failed to load settings:", err);
        setError("Failed to load settings. Please try again.");
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, [user, db]);

  const updateNotificationMode = async (mode: NotificationMode) => {
    if (!user) return;
    setSaving(true);
    try {
      const userRef = doc(db, "users", user.uid);
      await updateDoc(userRef, { upkeepNotificationMode: mode });
      setSettings(prev => ({ ...prev, upkeepNotificationMode: mode }));

      const messages: Record<NotificationMode, string> = {
        all: "Upkeep: Notifying for all tasks",
        subscribed: "Upkeep: Notifying for subscribed tasks only",
        off: "Upkeep: Notifications paused",
      };
      message.success(messages[mode]);
    } catch (error) {
      console.error("Failed to update notification mode:", error);
      message.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const clearAllTokens = async () => {
    if (!user) return;

    Modal.confirm({
      title: "Clear all notification tokens?",
      content: "This will remove all registered devices. You'll need to re-enable notifications on each device.",
      okText: "Clear",
      okButtonProps: { danger: true },
      onOk: async () => {
        setSaving(true);
        try {
          const userRef = doc(db, "users", user.uid);
          const tokens = settings.fcmTokens || [];
          if (tokens.length > 0) {
            await updateDoc(userRef, { fcmTokens: arrayRemove(...tokens) });
            setSettings(prev => ({ ...prev, fcmTokens: [] }));
            message.success("All notification tokens cleared");
          }
        } catch (error) {
          console.error("Failed to clear tokens:", error);
          message.error("Failed to clear tokens");
        } finally {
          setSaving(false);
        }
      },
    });
  };

  if (loading) {
    return (
      <PageContainer>
        <LoadingState>
          <Spin size="large" />
        </LoadingState>
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer>
        <Content>
          <PageTitle>Settings</PageTitle>
          <Section>
            <SettingRow style={{ background: "var(--color-error-bg, #fff2f0)" }}>
              <SettingInfo>
                <SettingLabel style={{ color: "var(--color-error, #cf1322)" }}>
                  {error}
                </SettingLabel>
                <Button onClick={() => window.location.reload()} style={{ marginTop: "var(--space-sm)" }}>
                  Retry
                </Button>
              </SettingInfo>
            </SettingRow>
          </Section>
        </Content>
      </PageContainer>
    );
  }

  const tokenCount = settings.fcmTokens?.length || 0;
  const notificationMode = settings.upkeepNotificationMode || "subscribed";

  return (
    <PageContainer>
      <Content>
        <PageTitle>Settings</PageTitle>

        {/* Notifications Section */}
        <Section>
          <SectionHeader>
            <SectionIcon><BellOutlined /></SectionIcon>
            <SectionTitle>Notifications</SectionTitle>
          </SectionHeader>

          <SettingRow>
            <SettingInfo>
              <SettingLabel>Registered Devices</SettingLabel>
              <SettingDescription>
                Devices that will receive push notifications
              </SettingDescription>
            </SettingInfo>
            <TokenInfo>
              <TokenCount $warning={tokenCount > 1}>
                {tokenCount} device{tokenCount !== 1 ? "s" : ""}
              </TokenCount>
              {tokenCount > 0 && (
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  loading={saving}
                  onClick={clearAllTokens}
                >
                  Clear
                </Button>
              )}
            </TokenInfo>
          </SettingRow>

          {tokenCount > 1 && (
            <SettingRow style={{ background: "var(--color-warning-bg, #fffbe6)" }}>
              <SettingInfo>
                <SettingLabel style={{ color: "var(--color-warning, #d48806)" }}>
                  Multiple devices registered
                </SettingLabel>
                <SettingDescription>
                  You may receive duplicate notifications. Clear tokens if this becomes an issue.
                </SettingDescription>
              </SettingInfo>
            </SettingRow>
          )}
        </Section>

        {/* Upkeep Section */}
        <Section>
          <SectionHeader>
            <SectionIcon><CheckSquareOutlined /></SectionIcon>
            <SectionTitle>Upkeep</SectionTitle>
          </SectionHeader>

          <SettingRow>
            <SettingInfo>
              <SettingLabel>Task Reminders</SettingLabel>
              <SettingDescription>
                Daily reminders at 8 AM for due household tasks
              </SettingDescription>
            </SettingInfo>
            <Segmented
              value={notificationMode}
              onChange={(v) => updateNotificationMode(v as NotificationMode)}
              disabled={saving}
              options={[
                { label: "All", value: "all" },
                { label: "Subscribed", value: "subscribed" },
                { label: "Off", value: "off" },
              ]}
            />
          </SettingRow>
        </Section>

        {/* Life Tracker Section */}
        <Section>
          <SectionHeader>
            <SectionIcon><ExperimentOutlined /></SectionIcon>
            <SectionTitle>Life Tracker</SectionTitle>
          </SectionHeader>

          <SettingRow>
            <SettingInfo>
              <SettingLabel>Random Sampling</SettingLabel>
              <SettingDescription>
                Configure sampling schedule in the Life Tracker app settings
              </SettingDescription>
            </SettingInfo>
            <Button
              onClick={() => window.location.href = "/life"}
            >
              Open Life Tracker
            </Button>
          </SettingRow>
        </Section>
      </Content>
    </PageContainer>
  );
}
