import { Tooltip } from "antd";
import styled from "styled-components";
import { useTravelBackend } from "@kirkl/shared";
import { activityUpdatesToBackend } from "../adapters";
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
  padding: 2px 4px;
  font-size: 14px;
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
  activityId: string;
  current: ActivityVerdict | undefined;
  size?: "sm" | "md";
}

export function VerdictButtons({ activityId, current }: Props) {
  const travel = useTravelBackend();

  const set = (next: ActivityVerdict) => {
    // Tap the same verdict twice to clear it.
    const value = current === next ? null : next;
    travel.updateActivity(
      activityId,
      activityUpdatesToBackend({
        verdict: value,
        experiencedAt: value ? new Date() : null,
      }),
    );
  };

  return (
    <Row>
      {VERDICTS.map((v) => (
        <Tooltip key={v.key} title={v.label}>
          <Btn type="button" $active={current === v.key} onClick={() => set(v.key)}>
            {v.emoji}
          </Btn>
        </Tooltip>
      ))}
    </Row>
  );
}
