import { useCallback, useState, useEffect } from "react";
import { Modal, Button, Switch } from "antd";
import { ReloadOutlined, DeleteOutlined, DownloadOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useLifeContext } from "../life-context";
import type { LifeLog } from "../types";
import type { LifeManifest } from "@homelab/backend";
import { RANDOM_SAMPLES } from "../manifest";
import { useUserBackend, useLifeBackend, useFeedback } from "@kirkl/shared";
import { useViews, useNotifications } from "../lib/views";
import { useTrackables } from "../lib/trackables";
import { NotificationsEditor } from "./NotificationsEditor";
import { ViewsEditor } from "./ViewsEditor";

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

const Section = styled.div`
  margin-top: var(--space-lg);
  padding-top: var(--space-md);
  border-top: 1px solid var(--color-border);
`;

const SectionTitle = styled.div`
  font-weight: 500;
  margin-bottom: var(--space-xs);
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-sm);
`;

const ReminderControls = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
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
  /** Export the full event log. Lives here as a rare action, off the top menu. */
  onExport?: (format: "csv" | "json") => void;
}

export function SettingsModal({ open, onClose, log, userId, onResetSchedule, onExport }: SettingsModalProps) {
  const user = useUserBackend();
  const life = useLifeBackend();
  const { message } = useFeedback();
  const { dispatch } = useLifeContext();
  const [showDebug, setShowDebug] = useState(false);
  const [fcmTokenCount, setFcmTokenCount] = useState<number | null>(null);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [savingSampling, setSavingSampling] = useState(false);
  const [savingCoach, setSavingCoach] = useState(false);

  const schedule = log?.sampleSchedule;
  const config = RANDOM_SAMPLES;
  const now = Date.now();

  // Unified Capture editors read the resolved manifest (Views / Notifications /
  // trackables) and mutate it through this RMW wrapper — mirror of ShapeSheet's
  // applyManifest: persist via the backend op, then re-dispatch SET_LOG so every
  // `useViews`/`useNotifications`/`useTrackables` consumer re-renders.
  const views = useViews();
  const notifications = useNotifications();
  const trackables = useTrackables();
  const applyManifest = useCallback(
    async (work: () => Promise<LifeManifest>) => {
      const manifest = await work();
      if (log) dispatch({ type: "SET_LOG", log: { ...log, manifest } });
      return manifest;
    },
    [log, dispatch],
  );

  const toggleRandomSampling = async (next: boolean) => {
    if (!log?.id) return;
    setSavingSampling(true);
    try {
      await life.setRandomSamplingEnabled(log.id, next);
      dispatch({
        type: "SET_LOG",
        log: { ...log, randomSamplingEnabled: next },
      });
    } catch (err) {
      console.error("Failed to update random sampling opt-in:", err);
      message.error("Failed to update random check-in setting");
    } finally {
      setSavingSampling(false);
    }
  };

  const toggleCoach = async (next: boolean) => {
    if (!log?.id) return;
    setSavingCoach(true);
    try {
      await life.setCoachEnabled(log.id, next);
      dispatch({
        type: "SET_LOG",
        log: { ...log, coachEnabled: next },
      });
    } catch (err) {
      console.error("Failed to update Coach opt-in:", err);
      message.error("Failed to update Coach setting");
    } finally {
      setSavingCoach(false);
    }
  };

  // Load FCM token count when debug is shown
  useEffect(() => {
    if (showDebug && userId && fcmTokenCount === null) {
      setLoadingTokens(true);
      user.listPushSubscriptions(userId)
        .then(subs => setFcmTokenCount(subs.length))
        .catch(() => setFcmTokenCount(-1))
        .finally(() => setLoadingTokens(false));
    }
  }, [showDebug, userId, fcmTokenCount]);

  const handleClearTokens = async () => {
    if (!userId) return;
    setLoadingTokens(true);
    try {
      await user.clearPushSubscriptions(userId);
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
      <Section>
        <SectionTitle>
          <span>Coach</span>
        </SectionTitle>
        <SettingRow>
          <div>
            <SettingLabel>Enable Coach</SettingLabel>
            <SettingDescription>
              AI observations, insights, and the analysis hub. When off, the
              Coach tab and its screens are hidden and no observations are
              generated.
            </SettingDescription>
          </div>
          <Switch
            checked={log?.coachEnabled ?? true}
            onChange={toggleCoach}
            loading={savingCoach}
            disabled={!log?.id}
          />
        </SettingRow>
      </Section>

      <Section>
        <SectionTitle>
          <span>Random check-ins</span>
        </SectionTitle>
        <SettingRow>
          <div>
            <SettingLabel>Push random check-ins</SettingLabel>
            <SettingDescription>
              Push a random check-in {config.timesPerDay}× per day between{" "}
              {config.activeHours?.[0]}:00 and {config.activeHours?.[1]}:00.
            </SettingDescription>
          </div>
          <Switch
            checked={!!log?.randomSamplingEnabled}
            onChange={toggleRandomSampling}
            loading={savingSampling}
            disabled={!log?.id}
          />
        </SettingRow>
      </Section>

      <Section>
        <SectionTitle>
          <span>Notifications</span>
        </SectionTitle>
        <SettingDescription>
          Scheduled nudges that open a View. Times are in your local timezone.
        </SettingDescription>
        <NotificationsEditor
          logId={log?.id}
          notifications={notifications}
          views={views}
          applyManifest={applyManifest}
        />
      </Section>

      <Section>
        <SectionTitle>
          <span>Views</span>
        </SectionTitle>
        <SettingDescription>
          The capture sessions a notification can open. Each View is an ordered set of prompts.
        </SettingDescription>
        <ViewsEditor logId={log?.id} views={views} trackables={trackables} applyManifest={applyManifest} />
      </Section>

      {onExport && (
        <Section>
          <SectionTitle>
            <span>Export</span>
          </SectionTitle>
          <SettingDescription>
            Download your full event log.
          </SettingDescription>
          <SettingRow>
            <SettingLabel>Data export</SettingLabel>
            <ReminderControls>
              <Button
                icon={<DownloadOutlined />}
                onClick={() => onExport("csv")}
              >
                CSV
              </Button>
              <Button
                icon={<DownloadOutlined />}
                onClick={() => onExport("json")}
              >
                JSON
              </Button>
            </ReminderControls>
          </SettingRow>
        </Section>
      )}

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
