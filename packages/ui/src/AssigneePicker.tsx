/**
 * AssigneePicker — view + edit a task's assignees.
 *
 * Renders the task's EFFECTIVE assignees as avatar chips:
 *   - explicit assignees (set on the task itself) render solid;
 *   - inherited assignees (from an assigned ancestor, or the `created_by` floor)
 *     render muted/ghost with an "inherited" hint.
 *
 * Clicking opens a Popover of the task list's owners; toggling writes an
 * explicit `assignees` override via `updateTask`; clearing every selection
 * writes `[]` so the task falls back to inheritance again.
 *
 * Resolution is the client mirror of the server's notify cascade
 * (`resolveAssignees` in @homelab/backend). Owner display names come from the
 * `user_names` view via `useUserNames` — no PII.
 */
import { useMemo } from "react";
import { Avatar, Checkbox, Popover, Tooltip } from "antd";
import { resolveAssignees, type AssigneeNode } from "@homelab/backend";
import { useUpkeepBackend } from "./backend-provider";
import { useUserNames } from "./useUserNames";

/** First letter of each of the first two words, uppercased. Falls back to "?". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Deterministic avatar tint per user id so the same person reads consistently.
const AVATAR_COLORS = ["#1677ff", "#52c41a", "#fa8c16", "#eb2f96", "#722ed1", "#13c2c2"];
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export interface AssigneePickerProps {
  /** The task whose assignees are shown/edited. Must satisfy `AssigneeNode`. */
  task: AssigneeNode;
  /** Every task in the same tree, keyed by id — needed to resolve inheritance. */
  tasksById: Map<string, AssigneeNode>;
  /** Candidate assignees = the owners of the task's list. */
  ownerIds: string[];
  /** Compact = small avatars only (row indicator). Default shows a fuller chip. */
  compact?: boolean;
}

export function AssigneePicker({ task, tasksById, ownerIds, compact = false }: AssigneePickerProps) {
  const upkeep = useUpkeepBackend();
  const { assignees, inherited } = useMemo(
    () => resolveAssignees(task, tasksById),
    [task, tasksById],
  );

  // Resolve display names for everyone we might show or offer.
  const names = useUserNames([...new Set([...ownerIds, ...assignees])]);
  const nameFor = (id: string) => names.get(id) || "User";

  const toggle = (id: string, checked: boolean) => {
    // From an INHERITED state, picking someone starts a fresh explicit override
    // (the ghost-preview set was never "selected" on this task). From an
    // EXPLICIT state we mutate the existing override in place.
    const base = inherited ? [] : assignees;
    const next = checked
      ? [...new Set([...base, id])]
      : base.filter((x) => x !== id);
    upkeep.updateTask(task.id, { assignees: next });
  };

  const size = compact ? 18 : 22;

  const chips = assignees.length === 0 ? (
    <span style={{ fontSize: compact ? 11 : 12, color: "#bfbfbf" }}>Unassigned</span>
  ) : (
    <Avatar.Group max={{ count: 4 }} size={size}>
      {assignees.map((id) => (
        <Tooltip key={id} title={inherited ? `${nameFor(id)} (inherited)` : nameFor(id)}>
          <Avatar
            size={size}
            style={{
              backgroundColor: inherited ? "#f0f0f0" : colorFor(id),
              color: inherited ? "#8c8c8c" : "#fff",
              border: inherited ? "1px dashed #d9d9d9" : "none",
              fontSize: compact ? 9 : 10,
            }}
          >
            {initialsOf(nameFor(id))}
          </Avatar>
        </Tooltip>
      ))}
    </Avatar.Group>
  );

  const popoverContent = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 160 }}>
      {ownerIds.length === 0 ? (
        <span style={{ fontSize: 12, color: "#8c8c8c" }}>No one to assign</span>
      ) : (
        ownerIds.map((id) => (
          <Checkbox
            key={id}
            // Only EXPLICIT assignees show as checked — inherited ones are a
            // ghost preview, not a selection on this task.
            checked={!inherited && assignees.includes(id)}
            onChange={(e) => toggle(id, e.target.checked)}
          >
            <Avatar
              size={18}
              style={{ backgroundColor: colorFor(id), fontSize: 9, marginRight: 6 }}
            >
              {initialsOf(nameFor(id))}
            </Avatar>
            {nameFor(id)}
          </Checkbox>
        ))
      )}
      {inherited && assignees.length > 0 && (
        <span style={{ fontSize: 11, color: "#bfbfbf", marginTop: 2 }}>
          Inherited — pick someone to override
        </span>
      )}
    </div>
  );

  return (
    <Popover
      content={popoverContent}
      title="Assignees"
      trigger="click"
      placement="bottomRight"
    >
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => e.stopPropagation()}
        style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
        title={inherited ? "Assignees (inherited)" : "Assignees"}
      >
        {chips}
        {!compact && inherited && assignees.length > 0 && (
          <span style={{ fontSize: 10, color: "#bfbfbf" }}>inherited</span>
        )}
      </span>
    </Popover>
  );
}
