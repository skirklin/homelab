# Recipe Box - Improvements

## Completed

- [x] Add meaningful tests (107 tests covering utils, reducer, storage classes)
- [x] Security fixes (npm audit fix, axios update)
- [x] Upgrade TypeScript 4.5 → 5.x
- [x] Upgrade React 17 → 18 (including createRoot API)
- [x] Upgrade antd 4 → 5 (removed CSS import, uses CSS-in-JS)
- [x] Upgrade styled-components 5 → 6
- [x] Upgrade react-router-dom 6.2 → 6.30
- [x] Upgrade Firebase 9 → 11
- [x] Replace FirebaseUI with custom antd login form (removed firebaseui/react-firebaseui dependencies)
- [x] Upgrade Node.js 17 → 20 (via nvm)
- [x] Migrate from Create React App (react-scripts) to Vite 7 + vitest
- [x] Split large files into focused modules
- [x] Add error boundaries

## Future Enhancements

- [x] Show notification highlighting "keep screen on" button for users who haven't seen it yet

## Notes

- All security vulnerabilities resolved after migrating to Vite
- Use `nvm use 20` before running npm commands (or add to shell profile)
