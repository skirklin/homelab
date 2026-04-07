import styled, { keyframes } from "styled-components";
import { Tooltip } from "antd";
import type { SyncStatus } from "../shopping-context";

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
`;

const Dot = styled.div<{ $status: SyncStatus }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ $status }) => {
    switch ($status) {
      case "synced":
        return "#52c41a"; // green
      case "pending":
        return "#faad14"; // yellow
      case "offline":
        return "#ff4d4f"; // red
    }
  }};
  animation: ${({ $status }) => ($status === "pending" ? pulse : "none")} 1.5s ease-in-out infinite;
`;

const statusLabels: Record<SyncStatus, string> = {
  synced: "Synced",
  pending: "Syncing...",
  offline: "Offline",
};

interface SyncIndicatorProps {
  status: SyncStatus;
}

export function SyncIndicator({ status }: SyncIndicatorProps) {
  return (
    <Tooltip title={statusLabels[status]} placement="bottom">
      <Dot $status={status} />
    </Tooltip>
  );
}
