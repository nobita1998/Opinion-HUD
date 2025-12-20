# Repository Guidelines

## Project Structure & Module Organization

- `backend/`: Python backend utilities for the data pipeline (fetch markets, enrich entities/keywords, build `data.json`).
- `extension/`: Chrome extension (Manifest V3) source and static assets; icons live in `extension/icons/`.
- `.github/workflows/`: CI workflows (currently empty; add lint/test automation here).
- Docs:
  - `README.md` (repo overview)
  - `extension/README.md` (frontend)
  - `backend/README.md` (backend)
  - `DEVELOPMENT.md` (architecture + design details)

## Build, Test, and Development Commands

Backend (Python) environment setup:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
```

Extension (manual run):

- In Chrome, open `chrome://extensions`, enable Developer mode, then “Load unpacked” and select `extension/` (once `manifest.json` and scripts are present).

## Coding Style & Naming Conventions

- Python: 4-space indentation, PEP 8, and type hints for public functions; keep modules small and single-purpose.
- Extension (JS/TS/CSS): 2-space indentation; prefer `kebab-case` filenames for assets and keep DOM selectors centralized.
- Tooling: no formatter/linter config is committed yet; if adding one, prefer `ruff`/`black` (Python) and `eslint`/`prettier` (extension).

## Testing Guidelines

- Automated tests are not set up yet. If you introduce tests, place Python tests under `backend/tests/` and name them `test_*.py` (pytest-friendly).
- For extension changes, include a short manual QA checklist in the PR (e.g., pages tested, hover/overlay behavior, performance impact).

## Commit & Pull Request Guidelines

- Commits: follow the existing history style—short, sentence-case subjects (example: “Add market fetch script”).
- PRs: include a clear summary, “How to test” steps (commands + manual steps), screenshots/GIFs for UI changes, and links to relevant issues.

## Security & Configuration Tips

- Never commit secrets (API keys, tokens). Use environment variables or a local `.env` (already gitignored).
- Keep external endpoints configurable; see `DEVELOPMENT.md`.
