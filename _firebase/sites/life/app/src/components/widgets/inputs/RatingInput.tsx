import { useState, useRef, useEffect } from "react";
import styled, { css } from "styled-components";
import { type WidgetSize } from "../../../display-settings";

const Container = styled.div`
  position: relative;
  display: inline-block;
`;

const Popup = styled.div`
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;

  /* Arrow */
  &::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-top-color: var(--color-bg);
  }
  &::before {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 7px solid transparent;
    border-top-color: var(--color-border);
  }
`;

const NumberRow = styled.div`
  display: flex;
  gap: 4px;
  flex-wrap: nowrap;
`;

const buttonSizeStyles = {
  compact: css`
    min-width: 24px;
    height: 24px;
    font-size: 11px;
  `,
  normal: css`
    min-width: 28px;
    height: 28px;
    font-size: 14px;
  `,
  comfortable: css`
    min-width: 34px;
    height: 34px;
    font-size: 16px;
  `,
};

const NumberButton = styled.button<{ $selected?: boolean; $size: WidgetSize }>`
  padding: 0 4px;
  border: 1px solid ${props => props.$selected ? 'var(--color-primary)' : 'var(--color-border)'};
  border-radius: 4px;
  background: ${props => props.$selected ? 'var(--color-primary)' : 'var(--color-bg)'};
  color: ${props => props.$selected ? 'white' : 'var(--color-text)'};
  cursor: pointer;
  font-weight: 500;
  flex-shrink: 0;
  ${(props) => buttonSizeStyles[props.$size]}

  &:hover:not(:disabled) {
    background: var(--color-primary);
    color: white;
    border-color: var(--color-primary);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const TriggerButton = styled(NumberButton)<{ $hasValue: boolean }>`
  min-width: ${props => props.$hasValue ? undefined : '40px'};
`;

interface RatingInputProps {
  value: number | null;
  onChange: (value: number | null) => void;
  max?: number;
  disabled?: boolean;
  size?: WidgetSize;
  /** If true, clicking the current value clears it */
  allowClear?: boolean;
}

export function RatingInput({
  value,
  onChange,
  max = 5,
  disabled = false,
  size = "normal",
  allowClear = true,
}: RatingInputProps) {
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const numbers = Array.from({ length: max }, (_, i) => i + 1);

  // Close on click outside
  useEffect(() => {
    if (!expanded) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [expanded]);

  const handleSelect = (n: number) => {
    if (allowClear && value === n) {
      onChange(null);
    } else {
      onChange(n);
    }
    setExpanded(false);
  };

  if (disabled) {
    // When disabled, just show the value
    return (
      <Container>
        <TriggerButton $size={size} $hasValue={value !== null} $selected={value !== null} disabled>
          {value ?? "—"}
        </TriggerButton>
      </Container>
    );
  }

  return (
    <Container ref={containerRef}>
      <TriggerButton
        $size={size}
        $hasValue={value !== null}
        $selected={value !== null}
        onClick={() => setExpanded(!expanded)}
      >
        {value ?? "—"}
      </TriggerButton>
      {expanded && (
        <Popup>
          <NumberRow>
            {numbers.map((n) => (
              <NumberButton
                key={n}
                $selected={value !== null && n <= value}
                $size={size}
                onClick={() => handleSelect(n)}
              >
                {n}
              </NumberButton>
            ))}
          </NumberRow>
        </Popup>
      )}
    </Container>
  );
}
