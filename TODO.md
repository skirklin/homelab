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

## Future Enhancements
- Deploy home app to home.kirkl.in
- Update Firebase hosting configuration for home app
- Consider deprecating standalone apps once home app is stable
