# Upkeep - Improvements

## Pending

- [ ] Simplify task states: remove "overdue" distinction, just show "due"
  - Currently tasks show as "due" then "overdue" after some threshold
  - Users don't need this distinction - if it's due, it's due

- [ ] Allow items to have custom entries with custom timestamps
  - Currently entries are auto-created when completing an item
  - Should allow users to manually add past entries (e.g., "I actually did this yesterday")
  - Requires UI for entering custom date/time when marking complete

## Completed

- [x] List sharing functionality with proper Firestore permissions
- [x] Unit tests for join flow
- [x] Integration tests with Firebase emulator
- [x] Fix duplicate notifications (use data-only FCM messages)
- [x] Namespaced localStorage with migration
- [x] Fix header button styling (antd CSS-in-JS override)
