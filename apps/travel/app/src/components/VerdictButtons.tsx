import { Tooltip } from "antd";
import styled from "styled-components";
import type { ActivityVerdict } from "../types";

const Row = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 2px;
`;

const Btn = styled.button<{ $active: boolean }>`
  background: ${(p) => (p.$active ? "#fff7e6" : "transparent")};
  border: 1px solid ${(p) => (p.$active ? "#ffd591" : "transparent")};
  border-radius: 4px;
  cursor: pointer;
  /* Touch-friendly on phones: a comfortable tap target without bloating the row. */
  padding: 4px 6px;
  font-size: 16px;
  line-height: 1;
  filter: ${(p) => (p.$active ? "none" : "grayscale(0.6) opacity(0.6)")};
  transition: filter 120ms, background 120ms, border-color 120ms;

  &:hover {
    filter: none;
    background: #fff7e6;
  }
`;

const VERDICTS: { key: ActivityVerdict; emoji: string; label: string }[] = [
  { key: "loved", emoji: "❤️", label: "Loved it" },
  { key: "liked", emoji: "👍", label: "Liked it" },
  { key: "meh", emoji: "😐", label: "Meh" },
  { key: "skip", emoji: "⏭️", label: "Would skip" },
];

interface Props {
  /** The CALLER'S own verdict (from their own note), not a shared scalar. */
  current: ActivityVerdict | undefined;
  /** Tap a verdict to set it; tap the active one again to clear (null). */
  onSet: (next: ActivityVerdict | null) => void;
}

/**
 * Presentational verdict picker. The owner (NotesThread) renders this inside the
 * caller's own reaction card, sourcing `current` from their own note and
 * persisting via `onSet` — the buttons themselves are stateless. Other authors'
 * verdicts render as a read-only text tag, not this control.
 */
export function VerdictButtons({ current, onSet }: Props) {
  return (
    <Row>
      {VERDICTS.map((v) => (
        <Tooltip key={v.key} title={v.label}>
          <Btn
            type="button"
            data-testid={`verdict-${v.key}`}
            data-active={current === v.key ? "true" : "false"}
            $active={current === v.key}
            onClick={() => onSet(current === v.key ? null : v.key)}
          >
            {v.emoji}
          </Btn>
        </Tooltip>
      ))}
    </Row>
  );
}
