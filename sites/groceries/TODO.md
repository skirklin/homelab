# Groceries - Improvements

## Pending

- [ ] Fix shopping history showing all trips as "Today"
  - `ShoppingTrips.tsx:formatDate()` calculates day difference correctly
  - Trips are saved with `Timestamp.now()` in `firestore.ts:135`
  - Trips are converted with `.toDate()` in `subscription.tsx:121`
  - Investigation needed: check actual Firestore data to see if timestamps are being stored correctly, or if there's a timezone/conversion issue

## Completed

- [x] List sharing functionality with proper Firestore permissions
- [x] Namespaced localStorage with migration
- [x] Fix list picker auto-redirect behavior (only redirect if saved list exists)
