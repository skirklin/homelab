/**
 * Unified Settings page for the home app.
 * Consolidates settings from all embedded apps in one place.
 */

import { useState, useEffect, useCallback } from "react";
import { Button, Input, List, Modal, Popconfirm, Segmented, Select, Spin, Typography } from "antd";
import {
  ApiOutlined,
  BellOutlined,
  CopyOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  CheckSquareOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { useAuth, getBackend, type NotificationMode, PageContainer, useFeedback } from "@kirkl/shared";

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

// --- API Token types and helpers ---

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  last_used: string | null;
  expires_at: string | null;
  created: string;
}

interface CreatedToken {
  token: string;
  name: string;
  prefix: string;
  expires_at: string | null;
}

function getApiBase() {
  return import.meta.env?.VITE_PB_URL || "https://api.beta.kirkl.in";
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getBackend().authStore.token}`,
  };
}

async function fetchTokens(): Promise<ApiToken[]> {
  const resp = await fetch(`${getApiBase()}/fn/auth/tokens`, {
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error("Failed to load tokens");
  return resp.json() as Promise<ApiToken[]>;
}

async function createApiToken(
  name: string,
  expiresInDays?: number,
): Promise<CreatedToken> {
  const resp = await fetch(`${getApiBase()}/fn/auth/tokens`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name, expires_in_days: expiresInDays }),
  });
  if (!resp.ok) throw new Error("Failed to create token");
  return resp.json() as Promise<CreatedToken>;
}

async function revokeApiToken(id: string): Promise<void> {
  const resp = await fetch(`${getApiBase()}/fn/auth/tokens/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error("Failed to revoke token");
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${Math.floor(diffMonths / 12)}y ago`;
}

function formatExpiry(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const now = new Date();
  if (date < now) return "Expired";
  return date.toLocaleDateString();
}

const EXPIRY_OPTIONS = [
  { label: "Never", value: 0 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
  { label: "1 year", value: 365 },
];

// --- Token list styled components ---

const TokenListItem = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-sm) var(--space-md);
  background: var(--color-bg);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-xs);
`;

const TokenMeta = styled.div`
  flex: 1;
  min-width: 0;
`;

const TokenName = styled.div`
  font-weight: 500;
`;

const TokenDetail = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-top: 2px;
`;

const CreatedTokenBox = styled.div`
  margin-top: var(--space-md);
  padding: var(--space-md);
  background: var(--color-bg);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-primary);
`;

const TokenCopyRow = styled.div`
  display: flex;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
`;

const VALID_NOTIFICATION_MODES: NotificationMode[] = ["all", "subscribed", "off"];

function isValidNotificationMode(value: unknown): value is NotificationMode {
  return typeof value === "string" && VALID_NOTIFICATION_MODES.includes(value as NotificationMode);
}

function parseUserSettings(data: Record<string, unknown>): UserSettings {
  const settings: UserSettings = {};

  if (isValidNotificationMode(data.upkeep_notification_mode)) {
    settings.upkeepNotificationMode = data.upkeep_notification_mode;
  }

  if (Array.isArray(data.fcm_tokens) && data.fcm_tokens.every((t: unknown) => typeof t === "string")) {
    settings.fcmTokens = data.fcm_tokens;
  }

  return settings;
}

export function Settings() {
  const { message, modal } = useFeedback();
  const { user } = useAuth();
  const [settings, setSettings] = useState<UserSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load user settings
  useEffect(() => {
    if (!user) return;

    const loadSettings = async () => {
      try {
        const record = await getBackend().collection("users").getOne(user.uid);
        setSettings(parseUserSettings(record));
      } catch (err) {
        console.error("Failed to load settings:", err);
        setError("Failed to load settings. Please try again.");
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, [user]);

  const updateNotificationMode = async (mode: NotificationMode) => {
    if (!user) return;
    setSaving(true);
    try {
      await getBackend().collection("users").update(user.uid, {
        upkeep_notification_mode: mode,
      });
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

    modal.confirm({
      title: "Clear all notification tokens?",
      content: "This will remove all registered devices. You'll need to re-enable notifications on each device.",
      okText: "Clear",
      okButtonProps: { danger: true },
      onOk: async () => {
        setSaving(true);
        try {
          await getBackend().collection("users").update(user.uid, {
            fcm_tokens: [],
          });
          setSettings(prev => ({ ...prev, fcmTokens: [] }));
          message.success("All notification tokens cleared");
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

        {/* API Tokens Section */}
        <ApiTokensSection />
      </Content>
    </PageContainer>
  );
}

// --- API Tokens Section Component ---

function ApiTokensSection() {
  const { message } = useFeedback();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenExpiry, setNewTokenExpiry] = useState(0);
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadTokens = useCallback(async () => {
    try {
      const data = await fetchTokens();
      setTokens(data);
    } catch {
      message.error("Failed to load API tokens");
    } finally {
      setLoadingTokens(false);
    }
  }, [message]);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  const handleCreate = async () => {
    if (!newTokenName.trim()) {
      message.warning("Token name is required");
      return;
    }
    setCreating(true);
    try {
      const result = await createApiToken(
        newTokenName.trim(),
        newTokenExpiry || undefined,
      );
      setCreatedToken(result);
      void loadTokens();
    } catch {
      message.error("Failed to create token");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      await revokeApiToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      message.success("Token revoked");
    } catch {
      message.error("Failed to revoke token");
    } finally {
      setRevokingId(null);
    }
  };

  const handleCloseModal = () => {
    setModalOpen(false);
    setNewTokenName("");
    setNewTokenExpiry(0);
    setCreatedToken(null);
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success("Copied to clipboard");
    } catch {
      message.error("Failed to copy");
    }
  };

  return (
    <Section>
      <SectionHeader>
        <SectionIcon><ApiOutlined /></SectionIcon>
        <SectionTitle>API Tokens</SectionTitle>
      </SectionHeader>

      <SettingRow>
        <SettingInfo>
          <SettingLabel>Personal Access Tokens</SettingLabel>
          <SettingDescription>
            Generate tokens for CLI tools and MCP integrations
          </SettingDescription>
        </SettingInfo>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setModalOpen(true)}
        >
          Create Token
        </Button>
      </SettingRow>

      {loadingTokens ? (
        <LoadingState><Spin /></LoadingState>
      ) : tokens.length > 0 ? (
        <List
          dataSource={tokens}
          renderItem={(token) => (
            <TokenListItem key={token.id}>
              <TokenMeta>
                <TokenName>{token.name}</TokenName>
                <TokenDetail>
                  {token.prefix}... &middot; Last used: {relativeTime(token.last_used)} &middot; Expires: {formatExpiry(token.expires_at)} &middot; Created: {new Date(token.created).toLocaleDateString()}
                </TokenDetail>
              </TokenMeta>
              <Popconfirm
                title="Revoke this token?"
                description="Any tools using this token will lose access."
                onConfirm={() => handleRevoke(token.id)}
                okText="Revoke"
                okButtonProps={{ danger: true }}
              >
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  loading={revokingId === token.id}
                >
                  Revoke
                </Button>
              </Popconfirm>
            </TokenListItem>
          )}
        />
      ) : (
        <SettingRow>
          <SettingInfo>
            <SettingDescription>No tokens created yet</SettingDescription>
          </SettingInfo>
        </SettingRow>
      )}

      <Modal
        title="Create API Token"
        open={modalOpen}
        onCancel={handleCloseModal}
        footer={
          createdToken
            ? [
                <Button key="done" type="primary" onClick={handleCloseModal}>
                  Done
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={handleCloseModal}>
                  Cancel
                </Button>,
                <Button
                  key="create"
                  type="primary"
                  loading={creating}
                  onClick={handleCreate}
                  disabled={!newTokenName.trim()}
                >
                  Create
                </Button>,
              ]
        }
      >
        {createdToken ? (
          <CreatedTokenBox>
            <Typography.Text strong>
              Token created: {createdToken.name}
            </Typography.Text>
            <TokenCopyRow>
              <Input.Password
                readOnly
                value={createdToken.token}
                visibilityToggle
                style={{ fontFamily: "monospace" }}
              />
              <Button
                icon={<CopyOutlined />}
                onClick={() => handleCopy(createdToken.token)}
              >
                Copy
              </Button>
            </TokenCopyRow>
            <Typography.Text type="warning" style={{ display: "block", marginTop: "var(--space-sm)" }}>
              Save this token now — it cannot be shown again.
            </Typography.Text>
          </CreatedTokenBox>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
            <div>
              <Typography.Text strong>Name</Typography.Text>
              <Input
                placeholder="e.g. MCP server, CLI tool"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                onPressEnter={handleCreate}
                style={{ marginTop: 4 }}
              />
            </div>
            <div>
              <Typography.Text strong>Expires</Typography.Text>
              <Select
                value={newTokenExpiry}
                onChange={setNewTokenExpiry}
                options={EXPIRY_OPTIONS}
                style={{ width: "100%", marginTop: 4 }}
              />
            </div>
          </div>
        )}
      </Modal>
    </Section>
  );
}
