# Contributing to Vanilla Admin Panel

Thank you for your interest in contributing!

This project aims to stay **simple, dependency-free, and understandable** (vanilla Node.js + SQLite + plain HTML/CSS/JS). We value clarity over "enterprise" patterns.

## How to contribute

### Reporting bugs
- Use the **Bug report** issue template.
- Include steps to reproduce, your environment (Node version, OS), and ideally a fresh database state.
- Try resetting the DB first (`rm db.sqlite && npm start`) before reporting.

### Suggesting features
- Use the **Feature request** template.
- Keep in mind the project philosophy: minimal dependencies, no heavy frameworks, easy to run locally.
- Large architectural changes (e.g. switching to Express, adding React frontend) are unlikely to be accepted unless they come with a very strong justification.

### Code contributions
1. Fork the repository and create a feature branch.
2. Make your changes.
3. Test manually (and add/update tests if applicable).
4. Open a Pull Request.

### Code style & guidelines
- Keep code readable. The project deliberately uses a relatively flat structure.
- All new API handlers should properly call `res.end()` or use the shared `sendJson()` helper.
- Frontend code (especially in `public/app.js` and `client/`) should initialize inside `document.addEventListener('DOMContentLoaded', ...)`.
- Prefer small, focused changes.
- Update `README.md` and `CHANGELOG.md` when adding user-facing changes.

### Running locally
```bash
npm install
npm start
```

For development with auto-reload:
```bash
npm run dev
```

### Testing
```bash
npm test
```

### Commit messages
Use clear, descriptive messages. Conventional commits style is appreciated but not required.

## License
By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?
Open an issue with the "question" label or start a discussion.
