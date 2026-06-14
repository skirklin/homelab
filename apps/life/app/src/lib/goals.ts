/**
 * Goal evaluator re-export. The implementation lives in `@homelab/backend`
 * (`life-goal-eval`) so the HabitBoard view and the MCP progress route call the
 * exact same pure function — there is one definition of "how is this goal
 * doing?". Import from here within the life app for locality.
 */
export { evaluateGoal } from "@homelab/backend";
export type { GoalProgress } from "@homelab/backend";
