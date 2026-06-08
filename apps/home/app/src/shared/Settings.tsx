/**
 * Unified Settings page for the home app.
 * Consolidates settings from all embedded apps in one place.
 */

import { useState, useEffect, useCallback } from "react";
import { Button, Input, List, Modal, Popconfirm, Segmented, Select, Spin, Typography } from "antd";
import {
  ApiOutlined,
  BellOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  CheckSquareOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { useAuth, getBackend, getApiBase, getAuthHeaders, type NotificationMode, PageContainer, useFeedback } from "@kirkl/shared";

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
  timezone?: string;
}

function detectBrowserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
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

function authHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...getAuthHeaders() };
}

async function fetchTokens(): Promise<ApiToken[]> {
  const resp = await fetch(`${getApiBase()}/auth/tokens`, {
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error("Failed to load tokens");
  return resp.json() as Promise<ApiToken[]>;
}

async function createApiToken(
  name: string,
  expiresInDays?: number,
): Promise<CreatedToken> {
  const resp = await fetch(`${getApiBase()}/auth/tokens`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name, expires_in_days: expiresInDays }),
  });
  if (!resp.ok) throw new Error("Failed to create token");
  return resp.json() as Promise<CreatedToken>;
}

async function revokeApiToken(id: string): Promise<void> {
  const resp = await fetch(`${getApiBase()}/auth/tokens/${id}`, {
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

// --- Claude MCP setup subsection styled components ---

const ClaudeIntro = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-md);
`;

const ClaudeCardStack = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
`;

const ClaudeCard = styled.div`
  padding: var(--space-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: var(--radius-md);
`;

const ClaudeCardTitle = styled.h3`
  font-size: var(--font-size-md);
  margin: 0 0 var(--space-xs) 0;
`;

const ClaudeCardLede = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-sm);
`;

const ClaudeSteps = styled.ol`
  margin: 0 0 var(--space-sm) 0;
  padding-left: var(--space-lg);
  font-size: var(--font-size-sm);
  li + li {
    margin-top: var(--space-xs);
  }
`;

const ClaudeUrlRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
`;

const ClaudeUrlValue = styled.code`
  flex: 1;
  min-width: 0;
  padding: var(--space-xs) var(--space-sm);
  background: var(--color-bg-muted, #f5f5f5);
  border-radius: var(--radius-sm, 4px);
  font-family: monospace;
  font-size: var(--font-size-sm);
  overflow-x: auto;
  white-space: nowrap;
`;

const ClaudeCodeBlockWrap = styled.div`
  position: relative;
  margin-top: var(--space-sm);
`;

const ClaudeCodeBlock = styled.pre`
  margin: 0;
  padding: var(--space-sm) var(--space-md);
  background: var(--color-bg-muted, #f5f5f5);
  border-radius: var(--radius-sm, 4px);
  font-family: monospace;
  font-size: var(--font-size-sm);
  overflow-x: auto;
  white-space: pre;
`;

const ClaudeCodeCopyRow = styled.div`
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-xs);
`;

const ClaudeNote = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
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

  if (typeof data.timezone === "string" && data.timezone) {
    settings.timezone = data.timezone;
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

      message.success(mode === "off" ? "Upkeep: Notifications paused" : "Upkeep: Notifications on");
    } catch (error) {
      console.error("Failed to update notification mode:", error);
      message.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const syncTimezone = async () => {
    if (!user) return;
    const tz = detectBrowserTz();
    if (!tz) {
      message.error("Couldn't detect your browser timezone");
      return;
    }
    setSaving(true);
    try {
      await getBackend().collection("users").update(user.uid, { timezone: tz });
      setSettings(prev => ({ ...prev, timezone: tz }));
      try { localStorage.setItem(`kirkl_tz_pushed:${user.uid}`, tz); } catch { /* ignore */ }
      message.success(`Saved timezone: ${tz}`);
    } catch (err) {
      console.error("Failed to save timezone:", err);
      message.error("Failed to save timezone");
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
  // Binary opt-out: only `off` is honored by the notification crons; the legacy
  // `all` / `subscribed` values both mean "on" (notify me about tasks I'm a
  // resolved recipient of). Surface a simple On/Off toggle.
  const notificationsOn = (settings.upkeepNotificationMode || "subscribed") !== "off";

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

        {/* Timezone Section */}
        {(() => {
          const browserTz = detectBrowserTz();
          const storedTz = settings.timezone || "";
          const inSync = !!storedTz && storedTz === browserTz;
          return (
            <Section>
              <SectionHeader>
                <SectionIcon><ClockCircleOutlined /></SectionIcon>
                <SectionTitle>Timezone</SectionTitle>
              </SectionHeader>
              <SettingRow>
                <SettingInfo>
                  <SettingLabel>{storedTz || "(not set)"}</SettingLabel>
                  <SettingDescription>
                    {inSync
                      ? `Auto-syncs from this browser. Travel push notifications fire at your local 7am and 8pm.`
                      : storedTz
                        ? `Browser is ${browserTz || "unknown"}. Push to overwrite, or it'll auto-sync next visit.`
                        : `Browser detected ${browserTz || "unknown"}. Click sync to save.`}
                  </SettingDescription>
                </SettingInfo>
                {!inSync && browserTz && (
                  <Button size="small" loading={saving} onClick={syncTimezone}>
                    Sync now
                  </Button>
                )}
              </SettingRow>
            </Section>
          );
        })()}

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
                Daily reminders at 8 AM for tasks you're a notification recipient of
              </SettingDescription>
            </SettingInfo>
            <Segmented
              value={notificationsOn ? "on" : "off"}
              onChange={(v) => updateNotificationMode(v === "on" ? "subscribed" : "off")}
              disabled={saving}
              options={[
                { label: "On", value: "on" },
                { label: "Off", value: "off" },
              ]}
            />
          </SettingRow>
        </Section>

        {/* API Tokens Section */}
        <ApiTokensSection />
      </Content>
    </PageContainer>
  );
}

// --- API Tokens Section Component ---

const MCP_URL = "https://mcp.kirkl.in/mcp";
const MCP_JSON_SNIPPET = `{
  "mcpServers": {
    "homelab": {
      "type": "http",
      "url": "https://mcp.kirkl.in/mcp",
      "headers": {
        "Authorization": "Bearer hlk_..."
      }
    }
  }
}`;

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

      {/* Connect Claude subsection */}
      <div style={{ marginTop: "var(--space-md)", marginBottom: "var(--space-md)" }}>
        <SettingLabel style={{ marginBottom: "var(--space-xs)" }}>Connect Claude</SettingLabel>
        <ClaudeIntro>
          Connect Claude to your homelab data (recipes, shopping, tasks, travel). Choose the path that matches your client.
        </ClaudeIntro>
        <ClaudeCardStack>
          <ClaudeCard>
            <ClaudeCardTitle>Claude mobile or desktop (OAuth)</ClaudeCardTitle>
            <ClaudeCardLede>
              Add as a custom MCP connector. No token needed; OAuth handles auth.
            </ClaudeCardLede>
            <ClaudeSteps>
              <li>In Claude, go to Connectors and tap Add custom connector.</li>
              <li>
                Use this URL:
                <ClaudeUrlRow>
                  <ClaudeUrlValue>{MCP_URL}</ClaudeUrlValue>
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    aria-label="Copy MCP URL"
                    onClick={() => handleCopy(MCP_URL)}
                  >
                    Copy
                  </Button>
                </ClaudeUrlRow>
              </li>
              <li>Sign in (Google or email/password) and tap Approve.</li>
            </ClaudeSteps>
          </ClaudeCard>

          <ClaudeCard>
            <ClaudeCardTitle>Claude Code (CLI / IDE)</ClaudeCardTitle>
            <ClaudeCardLede>
              Mint a Personal Access Token above, then add this to your project's <code>.mcp.json</code>:
            </ClaudeCardLede>
            <ClaudeCodeBlockWrap>
              <ClaudeCodeBlock>{MCP_JSON_SNIPPET}</ClaudeCodeBlock>
              <ClaudeCodeCopyRow>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  aria-label="Copy .mcp.json snippet"
                  onClick={() => handleCopy(MCP_JSON_SNIPPET)}
                >
                  Copy
                </Button>
              </ClaudeCodeCopyRow>
            </ClaudeCodeBlockWrap>
            <ClaudeNote>
              Replace <code>hlk_...</code> with the token shown when you create one above. The full token is shown only once at creation time.
            </ClaudeNote>
          </ClaudeCard>
        </ClaudeCardStack>
      </div>

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
