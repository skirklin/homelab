import { Modal, Segmented } from "antd";
import styled from "styled-components";
import { useDisplaySettings, type WidgetSize } from "../display-settings";

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

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { widgetSize, setWidgetSize } = useDisplaySettings();

  return (
    <Modal
      title="Display Settings"
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
    </Modal>
  );
}
