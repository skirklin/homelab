# Firebase Monorepo - Remaining Work

## Completed
- [x] Shared package (`@kirkl/shared`) with Firebase backend and auth
- [x] Groceries module refactored and integrated into home app
- [x] Recipes module refactored and integrated into home app
- [x] Upkeep module refactored and integrated into home app
- [x] Life tracker module in home app
- [x] Dashboard with links to all modules

## Remaining Test File Updates

### recipes/app
- `context.test.tsx` - Remove authUser references, update SET_AUTH_USER to RESET_STATE
- `utils.test.tsx` - Update getAppUserFromState calls to pass userId
- `recipes.test.tsx` - Schema type issues (pre-existing)

### upkeep/app
- `JoinList.test.tsx` - May need updates for new context

## Upkeep / Life Tracker Improvements
- [x] Remove 'overdue' category from upkeep tracker
- [x] Remember previously active sub-app and restore on load
- [x] Split life tracker into its own sites section (not embedded)
- [x] Make life tracker activities customizable instead of hard-coded
- [x] Prepare life tracking app for stats and data export features
- [x] Improve notes visibility on upkeep tasks, especially on mobile
- [x] Track all upkeep event history for timeline view per task
- [x] Allow creating manual upkeep events at prior datetimes
- [x] Review subapps for consistency (header, body, visual styling, space usage)

## Consistency Review Findings

### Current State
CSS variables are well-defined and mostly consistent across apps. Each app shares:
- Same spacing scale: xs (4px), sm (8px), md (16px), lg (24px), xl (32px)
- Same typography scale: xs through 2xl
- Same border radii and shadows
- Same neutral colors (text, bg, border variants)

Only primary/accent colors differ per app (intentional branding).

### Issues Found

**Header Styling:**
- Groceries: Subtle (white bg, border-bottom)
- Upkeep: Colored (primary bg, white text)
- Recipes: Gradient (primary gradient)
- Life: Inline section headers (no dedicated header)

**Container Max-Widths:**
- Groceries: 600px (narrow)
- Life: 800px (medium)
- Upkeep/Recipes: 1200px (wide)

**Hardcoded Pixels (should use CSS vars):**
- `sites/upkeep/app/src/components/TaskCard.tsx`: `padding: 4px 8px`, `gap: 2px`
- Some components use hardcoded heights (24px, 44px)

**Responsive Breakpoints:**
- No standardized breakpoint system
- Apps use different breakpoints: 480px, 600px, 768px, 900px, 1200px

### Recommendations (Low Priority)
1. Consider creating shared CSS file with standard breakpoints
2. Replace hardcoded pixel values with CSS variables
3. Standardize container max-widths (suggest 800px for single-column, 1200px for multi-column)
4. Document header styling decision (different per app may be intentional for visual distinction)

## Future Enhancements
- Deploy home app to home.kirkl.in
- Update Firebase hosting configuration for home app
- Consider deprecating standalone apps once home app is stable

## Groceries App
- [ ] Fix drag-and-drop category reassignment on mobile (currently broken)
  - Option A: Fix touch handling in dnd-kit
  - Option B: Add "Move to..." dropdown/modal on long-press as mobile alternative
- [ ] Revisit recipes→groceries integration after more usage (is adding one item at a time enough, or need "add all ingredients"?)

## Upkeep App
- [ ] Add snooze/defer feature for tasks
  - "Remind me in X days" or "Remind me on [date]"
  - Use case: traveling and can't do household tasks this week

## Life Tracker App (High Priority)
- [ ] **Data limit bug**: Only showing last 2 weeks of data - analysis mode needs ALL historical data
  - May need to paginate or lazy-load, but analysis view must have full dataset
- [ ] **Slow initial load**: ~5 seconds to open logging view adds friction
  - Investigate: Firestore persistence, bundle size, unnecessary data loading
  - Goal: Near-instant load for quick logging
- [ ] **Quick entry widget**: Way to log without opening the full app
  - PWA improvements for faster launch
  - Deep-link shortcut to minimal logging view
  - Native home screen widget (complex but ideal)

## Home App Shell
- [ ] Consider pinning app switcher at top of screen
  - Pro: No scrolling to switch apps
  - Con: Uses screen real estate
  - Compromise: Collapsible bar, or only pin on larger screens
