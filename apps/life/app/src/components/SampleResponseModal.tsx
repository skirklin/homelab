import { useState, useEffect } from "react";
import styled from "styled-components";
import { Modal, Button } from "antd";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import { type SampleQuestion, type RandomSamplesConfig, getTrackable } from "../manifest";

const QuestionContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
`;

const QuestionItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
`;

const QuestionLabel = styled.label`
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--color-text);
`;

const NumberRow = styled.div`
  display: flex;
  gap: 6px;
`;

const NumberButton = styled.button<{ $selected?: boolean }>`
  width: 36px;
  height: 36px;
  border: 2px solid ${props => props.$selected ? 'var(--color-primary)' : 'var(--color-border)'};
  border-radius: 8px;
  background: ${props => props.$selected ? 'var(--color-primary)' : 'var(--color-bg)'};
  color: ${props => props.$selected ? 'white' : 'var(--color-text)'};
  cursor: pointer;
  font-size: 16px;
  font-weight: 600;
`;

interface SampleResponseModalProps {
  open: boolean;
  onClose: () => void;
  config: RandomSamplesConfig | undefined;
  userId: string;
  logId: string | undefined;
}

export function SampleResponseModal({
  open,
  onClose,
  config,
  userId,
  logId,
}: SampleResponseModalProps) {
  const { message } = useFeedback();
  const life = useLifeBackend();
  // Map trackableId → numeric rating chosen.
  const [responses, setResponses] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (open) setResponses({});
  }, [open]);

  if (!config || !config.questions.length) return null;

  const setResponse = (id: string, value: number) =>
    setResponses((prev) => ({ ...prev, [id]: value }));

  const handleSubmit = async () => {
    if (!logId || !userId) return;
    const answered = Object.entries(responses).filter(([, v]) => typeof v === "number" && v > 0);
    if (answered.length === 0) {
      message.warning("Please answer at least one question");
      return;
    }
    setSaving(true);
    try {
      // Write one value-shaped event per answered question. Each lands as a
      // normal event under the question's trackable id, so it flows into the
      // same charts and aggregations as manually-logged ratings.
      await Promise.all(
        answered.map(([trackableId, value]) =>
          life.addEntry(logId, trackableId, { value, source: "sample" }, userId),
        ),
      );
      message.success("Response saved");
      onClose();
    } catch (err) {
      console.error("Failed to save response:", err);
      message.error("Failed to save response");
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => onClose();

  const renderQuestion = (question: SampleQuestion) => {
    const trackable = getTrackable(question.trackableId);
    const label = question.label ?? trackable?.label ?? question.trackableId;
    const max = 5;
    const currentValue = responses[question.trackableId];

    return (
      <QuestionItem key={question.trackableId}>
        <QuestionLabel>{label}</QuestionLabel>
        <NumberRow>
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <NumberButton
              key={n}
              $selected={currentValue !== undefined && n <= currentValue}
              onClick={() => setResponse(question.trackableId, n)}
            >
              {n}
            </NumberButton>
          ))}
        </NumberRow>
      </QuestionItem>
    );
  };

  return (
    <Modal
      title="Quick Check-in"
      open={open}
      onCancel={handleSkip}
      footer={[
        <Button key="skip" onClick={handleSkip}>Skip</Button>,
        <Button key="submit" type="primary" onClick={handleSubmit} loading={saving}>Submit</Button>,
      ]}
      maskClosable={false}
    >
      <QuestionContainer>
        {config.questions.map(renderQuestion)}
      </QuestionContainer>
    </Modal>
  );
}
