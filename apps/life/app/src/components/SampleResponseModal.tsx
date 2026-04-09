import { useState, useEffect } from "react";
import styled from "styled-components";
import { Modal, Button, InputNumber, Input } from "antd";
import { useFeedback } from "@kirkl/shared";
import type { SampleQuestion, RandomSamplesConfig } from "../types";
import { useLifeBackend } from "@kirkl/shared";

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

const InputWrapper = styled.div`
  display: flex;
  align-items: center;
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
  const [responses, setResponses] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  // Reset responses when modal opens
  useEffect(() => {
    if (open) {
      setResponses({});
    }
  }, [open]);

  if (!config || !config.questions.length) {
    return null;
  }

  const updateResponse = (questionId: string, value: unknown) => {
    setResponses((prev) => ({ ...prev, [questionId]: value }));
  };

  const handleSubmit = async () => {
    if (!logId || !userId) return;

    // Check if at least one question is answered
    const hasResponse = Object.values(responses).some(
      (v) => v !== undefined && v !== null && v !== "" && v !== 0
    );

    if (!hasResponse) {
      message.warning("Please answer at least one question");
      return;
    }

    setSaving(true);
    try {
      await life.addSampleResponse(logId, responses, userId);
      message.success("Response saved");
      onClose();
    } catch (error) {
      console.error("Failed to save response:", error);
      message.error("Failed to save response");
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => {
    onClose();
  };

  const renderQuestionInput = (question: SampleQuestion) => {
    const value = responses[question.id];

    switch (question.type) {
      case "rating": {
        const max = question.max || 5;
        const numbers = Array.from({ length: max }, (_, i) => i + 1);
        const currentValue = value as number | undefined;
        return (
          <NumberRow>
            {numbers.map((n) => (
              <NumberButton
                key={n}
                $selected={currentValue !== undefined && n <= currentValue}
                onClick={() => updateResponse(question.id, n)}
              >
                {n}
              </NumberButton>
            ))}
          </NumberRow>
        );
      }

      case "number":
        return (
          <InputNumber
            value={value as number | undefined}
            onChange={(v) => updateResponse(question.id, v)}
            min={question.min}
            placeholder="Enter a number"
            style={{ width: "100%" }}
          />
        );

      case "text":
        return (
          <Input.TextArea
            value={(value as string) || ""}
            onChange={(e) => updateResponse(question.id, e.target.value)}
            placeholder={question.placeholder || "Enter your response"}
            rows={3}
          />
        );

      default:
        return null;
    }
  };

  return (
    <Modal
      title="Quick Check-in"
      open={open}
      onCancel={handleSkip}
      footer={[
        <Button key="skip" onClick={handleSkip}>
          Skip
        </Button>,
        <Button key="submit" type="primary" onClick={handleSubmit} loading={saving}>
          Submit
        </Button>,
      ]}
      maskClosable={false}
    >
      <QuestionContainer>
        {config.questions.map((question) => (
          <QuestionItem key={question.id}>
            <QuestionLabel>{question.label}</QuestionLabel>
            <InputWrapper>{renderQuestionInput(question)}</InputWrapper>
          </QuestionItem>
        ))}
      </QuestionContainer>
    </Modal>
  );
}
