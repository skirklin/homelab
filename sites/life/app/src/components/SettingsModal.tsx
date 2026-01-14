import { useState } from "react";
import { Modal, Segmented, Button } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useDisplaySettings, type WidgetSize } from "../display-settings";
import type { LifeLog } from "../types";

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
  onResetSchedule?: () => void;
}

export function SettingsModal({ open, onClose, log, onResetSchedule }: SettingsModalProps) {
  const { widgetSize, setWidgetSize } = useDisplaySettings();
  const [showDebug, setShowDebug] = useState(false);

  const schedule = log?.sampleSchedule;
  const config = log?.manifest?.randomSamples;
  const now = Date.now();

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
              <div><strong>Config:</strong></div>
              <div>Times per day: {config.timesPerDay}</div>
              <div>Active hours: {config.activeHours?.join(' - ')}</div>
              <div>Timezone: {config.timezone || 'UTC (default)'}</div>
              <div>Questions: {config.questions?.length || 0}</div>

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
