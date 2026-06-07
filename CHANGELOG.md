# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0-beta] - 2026-06

### Added
- Light modular split of backend routes (`src/routes/`) for better maintainability while keeping the "vanilla & simple" spirit.
- Basic built-in test support using Node.js `node:test` (`npm test`).
- GitHub issue templates (bug report + feature request).
- `CONTRIBUTING.md` and updated project structure in README.
- Stronger first-run security warnings and console output.
- Screenshots section in README (placeholders — please add real ones!).

### Changed
- Version bumped to 0.3.0-beta.
- Improved `package.json` metadata (repository, bugs, homepage, scripts).
- Updated limitations section in README to reflect current state.
- Minor improvements to error handling consistency and input validation.

### Security
- Added guidance and stronger warnings about default credentials.
- Recommended (and documented) immediate password change for `superadmin` on first use.

### Notes
This is the first **beta** release. The project is more polished than alpha, but still expects users to review security before any public/self-hosted production use.

See the full list of known limitations in [README.md](README.md#-%D0%BE%D0%B3%D1%80%D0%B0%D0%BD%D0%B8%D1%87%D0%B5%D0%BD%D0%B8%D1%8F-alpha).

## [0.2.0-alpha] - Previous

Initial public alpha release.
- Core features: public blog, personal cabinet with support chat, full admin panel (articles, media library, users, tickets, settings, logs).
- Strong bot protection on registration (math captcha + honeypots + rate limiting + server verification).
- Persistent sessions in SQLite.
- Base64 file uploads.
- Default accounts + demo data seeding.
- Demo reset endpoint for easy showcasing.
