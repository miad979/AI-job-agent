# Orbit — AI job agent

A private job-search workspace with a real agent loop: **discover → match → tailor → human approval → track**.

Orbit comes in two editions built from the same code:

| | Full edition | Browser-only edition |
|---|---|---|
| Runs as | Express API + SQLite, serving the UI | Static site (GitHub Pages), no server |
| Accounts | Email + password, many users | One workspace per browser, just a name |
| Data lives in | `data/orbit.db` on the server | The browser's `localStorage` |
| AI drafting | Groq or Ollama via `.env`, else template | Your own Groq key saved in the browser, else template |

Both run the same rules (`shared/core.ts`), so matching, drafting and the approval gate behave identically.

## Run the full edition

```bash
npm install
cp .env.example .env     # then edit (optional: add GROQ_API_KEY and set AI_PROVIDER=groq)
npm run dev:full         # API on :8787, UI on :5173
```

Production-style: `npm start` builds the UI and serves it from the API on `PORT`.

## Run or deploy the browser-only edition

```bash
npm run dev:pages        # http://localhost:5173/AI-job-agent/
npm run deploy           # builds with --mode pages and publishes dist/ to the gh-pages branch
```

The Pages build is served under `/AI-job-agent/`; change `base` in `vite.config.ts` if the repository is renamed.
To point the Pages site at a hosted Orbit API instead of browser storage, see `.env.pages` and set `CORS_ORIGINS` on the server.

## Checks

```bash
npm test                 # 35 tests: API over in-memory SQLite, the browser-only backend, job sources; no network
npm run typecheck
npm run lint
```

CI (`.github/workflows/ci.yml`) runs all three plus both builds on every push and pull request.

## What is real

- **Auth** (full edition): signup/login with bcrypt, hashed 14-day session tokens, login rate-limit; every record is scoped to the user. Accounts can be deleted, which removes all of their data.
- **Live listings**: Remotive and Jobicy (free public APIs, no key), merged, de-duplicated and filtered by your search. Every card credits its source and links to the original listing. `JOB_SOURCE` in `.env` selects `all`, `remotive`, `jobicy` or `demo`.
- **Agent** (`POST /api/agent/run`): searches those listings, scores each against *your* resume, drafts a summary + cover letter (Groq/Ollama, or a deterministic template), and queues them for review. Never duplicates a job.
- **Location preference**: listings open to the place in your profile (or worldwide) are marked ✓, and the agent drafts those first.
- **Resume import**: PDF, DOCX, TXT and Markdown are read in the browser; only the extracted text is stored.
- **Truthfulness**: prompts and templates only use facts in your resume; the UI makes you review/edit before anything leaves.
- **Approval gate**: "Approve & apply" opens the real listing; Orbit marks *Submitted* only after you confirm you applied. Orbit does not auto-submit to third-party boards (they require logins/CAPTCHAs and forbid it).
- **Saved jobs**: star a listing to keep it, with its details, in the Saved view.
- **SDLC report**: Requirements → Discovery → Tailoring → Review → Submission → Outcome, computed from your data, with an audit trail and Markdown export.

## Layout

- `shared/` — matching, tailoring and the pipeline rules; used by both editions
- `server/` — Express app: auth and SQLite storage
- `src/` — React UI; `src/api.ts` picks the server or the in-browser backend
- `tests/` — `node:test` suites

## Security

Never commit `.env` or share a zip containing it. Rotate any API key that has been shared.
In the browser-only edition a Groq key is stored unencrypted in that browser's `localStorage`; use it only on a device you trust.
