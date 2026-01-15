import { useState, useEffect } from "react";
import { Modal, Segmented, Button } from "antd";
import { ReloadOutlined, DeleteOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useDisplaySettings, type WidgetSize } from "../display-settings";
import type { LifeLog } from "../types";
import { getFcmTokens, clearAllFcmTokens } from "../firestore";

const SettingRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-sm) 0;
`;

const SettingLabel = styled.div`
  font-weight: 500;
`;

const SettingDescription = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-top: 2px;
`;

const DebugSection = styled.div`
  margin-top: var(--space-lg);
  padding-top: var(--space-md);
  border-top: 1px solid var(--color-border);
`;

const DebugHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  padding: var(--space-xs) 0;
`;

const DebugTitle = styled.div`
  font-weight: 500;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

const DebugContent = styled.div`
  margin-top: var(--space-sm);
  font-size: var(--font-size-sm);
  font-family: monospace;
  background: var(--color-bg-muted);
  padding: var(--space-sm);
  border-radius: var(--radius-sm);
  white-space: pre-wrap;
  word-break: break-all;
`;

const ScheduleTime = styled.div<{ $sent: boolean; $pending: boolean }>`
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  color: ${props => props.$sent ? 'var(--color-text-muted)' : props.$pending ? 'var(--color-warning)' : 'var(--color-text)'};
`;

const StatusBadge = styled.span<{ $type: 'sent' | 'pending' | 'upcoming' }>`
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: ${props =>
    props.$type === 'sent' ? 'var(--color-bg-muted)' :
    props.$type === 'pending' ? 'var(--color-warning-bg, #fff3cd)' :
    'var(--color-primary-bg, #e6f7ff)'};
  color: ${props =>
    props.$type === 'sent' ? 'var(--color-text-muted)' :
    props.$type === 'pending' ? 'var(--color-warning, #d48806)' :
    'var(--color-primary)'};
`;

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  log?: LifeLog | null;
  userId?: string;
  onResetSchedule?: () => void;
}

export function SettingsModal({ open, onClose, log, userId, onResetSchedule }: SettingsModalProps) {
  const { widgetSize, setWidgetSize } = useDisplaySettings();
  const [showDebug, setShowDebug] = useState(false);
  const [fcmTokenCount, setFcmTokenCount] = useState<number | null>(null);
  const [loadingTokens, setLoadingTokens] = useState(false);

  const schedule = log?.sampleSchedule;
  const config = log?.manifest?.randomSamples;
  const now = Date.now();

  // Load FCM token count when debug is shown
  useEffect(() => {
    if (showDebug && userId && fcmTokenCount === null) {
      setLoadingTokens(true);
      getFcmTokens(userId)
        .then(tokens => setFcmTokenCount(tokens.length))
        .catch(() => setFcmTokenCount(-1))
        .finally(() => setLoadingTokens(false));
    }
  }, [showDebug, userId, fcmTokenCount]);

  const handleClearTokens = async () => {
    if (!userId) return;
    setLoadingTokens(true);
    try {
      await clearAllFcmTokens(userId);
      setFcmTokenCount(0);
    } catch (e) {
      console.error("Failed to clear tokens:", e);
    } finally {
      setLoadingTokens(false);
    }
  };

  const formatTime = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getTimeStatus = (ts: number): 'sent' | 'pending' | 'upcoming' => {
    if (schedule?.sentTimes?.includes(ts)) return 'sent';
    if (ts <= now) return 'pending';
    return 'upcoming';
  };

  return (
    <Modal
      title="Settings"
      open={open}
      onCancel={onClose}
      footer={null}
    >
      <SettingRow>
        <div>
          <SettingLabel>Widget Size</SettingLabel>
          <SettingDescription>Adjust the size of tracker widgets</SettingDescription>
        </div>
        <Segmented
          value={widgetSize}
          onChange={(v) => setWidgetSize(v as WidgetSize)}
          options={[
            { label: "Compact", value: "compact" },
            { label: "Normal", value: "normal" },
            { label: "Large", value: "comfortable" },
          ]}
        />
      </SettingRow>

      {config?.enabled && (
        <DebugSection>
          <DebugHeader onClick={() => setShowDebug(!showDebug)}>
            <DebugTitle>Sampling Debug {showDebug ? '▼' : '▶'}</DebugTitle>
            {showDebug && onResetSchedule && (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onResetSchedule();
                }}
              >
                Reset Schedule
              </Button>
            )}
          </DebugHeader>

          {showDebug && (
            <DebugContent>
              <div><strong>Log:</strong></div>
              <div>Log ID: {log?.id || 'N/A'}</div>

              <div style={{ marginTop: 12 }}><strong>Config:</strong></div>
              <div>Times per day: {config.timesPerDay}</div>
              <div>Active hours: {config.activeHours?.join(' - ')}</div>
              <div>Timezone: {config.timezone || 'UTC (default)'}</div>
              <div>Questions: {config.questions?.length || 0}</div>

              <div style={{ marginTop: 12 }}><strong>FCM Tokens:</strong></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  Registered: {loadingTokens ? '...' : fcmTokenCount === -1 ? 'Error' : fcmTokenCount ?? '...'}
                  {fcmTokenCount !== null && fcmTokenCount > 1 && (
                    <span style={{ color: 'var(--color-warning)', marginLeft: 8 }}>
                      (multiple tokens = multiple notifications!)
                    </span>
                  )}
                </span>
                {fcmTokenCount !== null && fcmTokenCount > 0 && (
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    loading={loadingTokens}
                    onClick={handleClearTokens}
                  >
                    Clear All
                  </Button>
                )}
              </div>

              <div style={{ marginTop: 12 }}><strong>Today's Schedule:</strong></div>
              {schedule ? (
                <>
                  <div>Date: {schedule.date}</div>
                  <div style={{ marginTop: 8 }}>
                    {schedule.times?.length > 0 ? (
                      schedule.times.map((ts) => {
                        const status = getTimeStatus(ts);
                        return (
                          <ScheduleTime
                            key={ts}
                            $sent={status === 'sent'}
                            $pending={status === 'pending'}
                          >
                            <span>{formatTime(ts)}</span>
                            <StatusBadge $type={status}>
                              {status === 'sent' ? 'Sent' : status === 'pending' ? 'Pending' : 'Upcoming'}
                            </StatusBadge>
                          </ScheduleTime>
                        );
                      })
                    ) : (
                      <div>No times scheduled</div>
                    )}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-muted)' }}>
                    Sent: {schedule.sentTimes?.length || 0} / {schedule.times?.length || 0}
                  </div>
                </>
              ) : (
                <div>No schedule generated yet</div>
              )}
            </DebugContent>
          )}
        </DebugSection>
      )}
    </Modal>
  );
}
