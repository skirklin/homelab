import { useState, useEffect, useCallback } from "react";
import styled from "styled-components";
import { Modal, Button, Alert, message } from "antd";
import type { LifeManifest } from "../types";
import { parseAndValidateManifest, formatValidationErrors } from "../manifest-validation";
import { updateManifest } from "../firestore";

const EditorContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
`;

const TextArea = styled.textarea<{ $hasError?: boolean }>`
  width: 100%;
  height: 400px;
  font-family: monospace;
  font-size: var(--font-size-sm);
  padding: var(--space-md);
  border: 1px solid ${props => props.$hasError ? '#ff4d4f' : 'var(--color-border)'};
  border-radius: var(--radius-md);
  resize: vertical;

  &:focus {
    outline: none;
    border-color: ${props => props.$hasError ? '#ff4d4f' : 'var(--color-primary)'};
  }
`;

const HelpText = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

interface ManifestEditorProps {
  open: boolean;
  onClose: () => void;
  manifest: LifeManifest;
  logId: string | undefined;
  onManifestUpdated: (manifest: LifeManifest) => void;
}

export function ManifestEditor({
  open,
  onClose,
  manifest,
  logId,
  onManifestUpdated,
}: ManifestEditorProps) {
  const [jsonText, setJsonText] = useState("");
  const [errors, setErrors] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setJsonText(JSON.stringify(manifest, null, 2));
      setErrors(null);
    }
  }, [open, manifest]);

  // Auto-validate on change (debounced)
  useEffect(() => {
    if (!jsonText) return;

    const timer = setTimeout(() => {
      const result = parseAndValidateManifest(jsonText);
      if (!result.valid) {
        setErrors(formatValidationErrors(result.errors));
      } else {
        setErrors(null);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [jsonText]);

  // Auto-format on blur
  const handleBlur = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      const formatted = JSON.stringify(parsed, null, 2);
      if (formatted !== jsonText) {
        setJsonText(formatted);
      }
    } catch {
      // Invalid JSON, don't format
    }
  }, [jsonText]);

  const handleSave = async () => {
    if (!logId) return;

    const result = parseAndValidateManifest(jsonText);
    if (!result.valid || !result.manifest) {
      setErrors(formatValidationErrors(result.errors));
      return;
    }

    setSaving(true);
    try {
      await updateManifest(result.manifest, logId);
      onManifestUpdated(result.manifest);
      message.success("Configuration saved");
      onClose();
    } catch (error) {
      console.error("Failed to save manifest:", error);
      message.error("Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setJsonText(JSON.stringify(manifest, null, 2));
    setErrors(null);
    onClose();
  };

  return (
    <Modal
      title="Configure Tracking"
      open={open}
      onCancel={handleCancel}
      footer={[
        <Button key="cancel" onClick={handleCancel}>
          Cancel
        </Button>,
        <Button key="save" type="primary" onClick={handleSave} loading={saving} disabled={!!errors}>
          Save
        </Button>,
      ]}
      width={700}
    >
      <EditorContainer>
        <HelpText>
          Edit the JSON configuration below. Widget types: counter, number, rating, text, combo.
        </HelpText>

        <TextArea
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          onBlur={handleBlur}
          spellCheck={false}
          $hasError={!!errors}
        />

        {errors && (
          <Alert
            type="error"
            message="Validation Errors"
            description={<pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{errors}</pre>}
          />
        )}

        <HelpText>
          <strong>Example widget types:</strong>
          <pre style={{ margin: "8px 0", fontSize: "12px" }}>
{`{ "id": "meds", "type": "counter", "label": "Meds" }
{ "id": "hours", "type": "number", "label": "Hours", "min": 0, "max": 24, "unit": "h" }
{ "id": "mood", "type": "rating", "label": "Mood", "max": 5 }
{ "id": "notes", "type": "text", "label": "Notes" }
{ "id": "sleep", "type": "combo", "label": "Sleep", "fields": [...] }`}
          </pre>
        </HelpText>
      </EditorContainer>
    </Modal>
  );
}
