import { Modal, Input, Button, message } from "antd";
import { Form, FormField, Label } from "./styles";

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  shareUrl: string;
  description?: string;
}

/**
 * Modal for sharing a link with copy-to-clipboard functionality.
 * Used for sharing lists, boxes, etc.
 */
export function ShareModal({
  open,
  onClose,
  title,
  shareUrl,
  description = "Share this link with others to let them join:",
}: ShareModalProps) {
  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareUrl);
    message.success("Link copied!");
    onClose();
  };

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        <Button key="copy" type="primary" onClick={handleCopyLink}>
          Copy Link
        </Button>,
      ]}
    >
      <Form>
        <p style={{ margin: 0, color: "var(--color-text-secondary)" }}>
          {description}
        </p>
        <FormField>
          <Label>Share link</Label>
          <Input value={shareUrl} readOnly />
        </FormField>
      </Form>
    </Modal>
  );
}
