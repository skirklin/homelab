import styled, { css } from "styled-components";
import { type WidgetSize } from "../../../display-settings";

const NumberRow = styled.div`
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
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
  const numbers = Array.from({ length: max }, (_, i) => i + 1);

  const handleClick = (n: number) => {
    if (allowClear && value === n) {
      onChange(null);
    } else {
      onChange(n);
    }
  };

  return (
    <NumberRow>
      {numbers.map((n) => (
        <NumberButton
          key={n}
          $selected={value !== null && n <= value}
          $size={size}
          disabled={disabled}
          onClick={() => handleClick(n)}
        >
          {n}
        </NumberButton>
      ))}
    </NumberRow>
  );
}
