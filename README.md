# Orbit — AI job agent

A private job-search workspace with a real agent loop: **discover → match → tailor → human approval → track**.

## Run

```bash
npm install
cp .env.example .env     # then edit (optional: add GROQ_API_KEY and set AI_PROVIDER=groq)
npm run dev:full         # API on :8787, UI on :5173
```

Production-style: `npm start` builds the UI and serves it from the API on `PORT`.
Tests: `npm test` (17 API/unit tests, in-memory SQLite, no network).

## What is real

- **Auth**: signup/login with bcrypt, hashed 14-day session tokens, login rate-limit; every record is scoped to the user.
- **Agent** (`POST /api/agent/run`): searches live listings (Remotive), scores each against *your* resume, drafts a summary + cover letter (Groq/Ollama, or a deterministic template), and queues them for review. Never duplicates a job.
- **Truthfulness**: prompts and templates only use facts in your resume; the UI makes you review/edit before anything leaves.
- **Approval gate**: "Approve & apply" opens the real listing; Orbit marks *Submitted* only after you confirm you applied. Orbit does not auto-submit to third-party boards (they require logins/CAPTCHAs and forbid it).
- **SDLC report**: Requirements → Discovery → Tailoring → Review → Submission → Outcome, computed from your data, with an audit trail and Markdown export.

## Security

Never commit `.env` or share a zip containing it. Rotate any API key that has been shared.
