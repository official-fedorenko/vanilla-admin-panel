# Release v0.3.0-beta

## Summary
This is the first **beta** release of Vanilla Admin Panel.

The project has moved from early alpha to a more polished beta state with:
- Light modular structure for backend routes
- Basic test coverage
- Stronger security warnings and guidance
- Proper release artifacts (CHANGELOG, CONTRIBUTING, issue templates)
- Improved documentation and first-run experience

## Highlights
- Better onboarding for people who want to try the project
- Clearer security posture for self-hosted use
- Maintains the core philosophy: pure Node.js, SQLite, zero heavy frameworks, vanilla frontend

## Important for Users
- **Always change the default passwords** immediately after first start.
- The console now shows prominent beta security warnings.
- Login API returns `securityWarning` for default accounts.
- Recommended to run behind a reverse proxy with HTTPS for any real usage.

See full CHANGELOG.md for details.

## Installation (same as before)
```bash
git clone https://github.com/yourusername/vanilla-admin-panel.git
cd vanilla-admin-panel
npm install
npm start
```

Open http://localhost:3080

Default accounts (change them!):
- superadmin / 1234qwer
- admin / 1234qwer  
- user / 1234qwer

## Links
- Full README: https://github.com/yourusername/vanilla-admin-panel#readme
- Issues: https://github.com/yourusername/vanilla-admin-panel/issues
