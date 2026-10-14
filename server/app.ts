import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DEMO_JOBS, fetchRemotive, llmTailoring, scoreJob, templateTailoring } from "./lib.ts";
import type { Job, Tailoring } from "./lib.ts";

type Db = InstanceType<typeof Database>;
export const STATUSES = ["Review", "Submitted", "Interview", "Offer", "Rejected"] as const;
type Status = (typeof STATUSES)[number];
type User = { id: number; email: string; name: string };
type AppRow = { id: number; user_id: number; job_id: number; job_json: string; status: Status; match: number; summary: string; cover_letter: string; generated_by: string; created_at: string; updated_at: string; submitted_at: string | null };

export type AppOptions = { db: Db; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; getJobs?: (query: string) => Promise<Job[]>; staticDir?: string };

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Upgrade from the earlier single-user prototype schema (demo rows only).
  const cols = db.prepare("PRAGMA table_info(applications)").all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "user_id")) db.exec("DROP TABLE applications; DROP TABLE IF EXISTS profile;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, target_role TEXT NOT NULL DEFAULT '', job_type TEXT NOT NULL DEFAULT 'All types', location TEXT NOT NULL DEFAULT '', resume_text TEXT NOT NULL DEFAULT '', resume_name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS applications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_id INTEGER NOT NULL, job_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Review', match INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', cover_letter TEXT NOT NULL DEFAULT '', generated_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT, UNIQUE(user_id, job_id));
    CREATE TABLE IF NOT EXISTS saved_jobs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_id INTEGER NOT NULL, PRIMARY KEY (user_id, job_id));
    CREATE TABLE IF NOT EXISTS agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, query TEXT NOT NULL, found INTEGER NOT NULL, considered INTEGER NOT NULL, queued INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, application_id INTEGER, stage TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  return db;
}

const now = () => new Date().toISOString();
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

export function createApp({ db, env = process.env, fetchImpl = fetch, getJobs, staticDir }: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] }));
  app.use(express.json({ limit: "2mb" }));
  app.use((_req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); next(); });

  const failures = new Map<string, { n: number; until: number }>();
  const log = (userId: number, stage: string, message: string, applicationId?: number) => db.prepare("INSERT INTO events (user_id, application_id, stage, message, created_at) VALUES (?, ?, ?, ?, ?)").run(userId, applicationId ?? null, stage, message, now());

  const bearer = (req: Request) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const auth = (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req);
    const user = token ? db.prepare("SELECT u.id, u.email, u.name FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?").get(hashToken(token), now()) as User | undefined : undefined;
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
    res.locals.user = user;
    next();
  };
  const optionalUser = (req: Request): User | undefined => {
    const token = bearer(req);
    return token ? db.prepare("SELECT u.id, u.email, u.name FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?").get(hashToken(token), now()) as User | undefined : undefined;
  };
  const uid = (res: Response) => (res.locals.user as User).id;
  const newSession = (userId: number) => {
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hashToken(token), userId, now(), new Date(Date.now() + 14 * 864e5).toISOString());
    return token;
  };
  const getProfile = (userId: number) => {
    const row = db.prepare("SELECT target_role AS targetRole, job_type AS jobType, location, resume_text AS resumeText, resume_name AS resumeName FROM profiles WHERE user_id = ?").get(userId) as { targetRole: string; jobType: string; location: string; resumeText: string; resumeName: string } | undefined;
    return row ?? { targetRole: "", jobType: "All types", location: "", resumeText: "", resumeName: "" };
  };
  const toApp = (r: AppRow) => ({ id: r.id, jobId: r.job_id, job: JSON.parse(r.job_json) as Job, status: r.status, match: r.match, summary: r.summary, coverLetter: r.cover_letter, generatedBy: r.generated_by, createdAt: r.created_at, updatedAt: r.updated_at, submittedAt: r.submitted_at });
  const listApps = (userId: number) => (db.prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY id DESC").all(userId) as AppRow[]).map(toApp);
  const ownApp = (userId: number, id: unknown) => db.prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?").get(Number(id), userId) as AppRow | undefined;

  const sanitizeJob = (raw: unknown): Job | null => {
    const j = raw as Partial<Job> | undefined;
    if (!j || !Number.isFinite(Number(j.id)) || !j.company || !j.role) return null;
    return { id: Number(j.id), company: str(j.company, 120), role: str(j.role, 160), type: str(j.type, 40) || "Unspecified", location: str(j.location, 120) || "Remote", salary: str(j.salary, 80) || "Salary not listed", skills: Array.isArray(j.skills) ? j.skills.slice(0, 10).map((s) => str(s, 40)) : [], url: j.url && /^https?:\/\//.test(j.url) ? str(j.url, 500) : undefined, source: str(j.source, 40) || "unknown", description: str(j.description, 3000), posted: str(j.posted, 30) || "recent" };
  };

  const loadJobs = async (query: string, type: string) => {
    let jobs: Job[] = [];
    let source = "demo";
    if (getJobs) { jobs = await getJobs(query); source = jobs[0]?.source ?? "custom"; }
    else if ((env.JOB_SOURCE ?? "remotive") === "remotive") {
      try { jobs = await fetchRemotive(query, fetchImpl); source = "Remotive"; } catch (error) { console.warn("Remotive unavailable, using demo jobs:", error instanceof Error ? error.message : error); }
    }
    if (!jobs.length && source !== "Remotive") { const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2); jobs = DEMO_JOBS.filter((j) => !words.length || words.some((w) => `${j.role} ${j.company} ${j.skills.join(" ")}`.toLowerCase().includes(w))); source = "demo"; }
    if (type && type !== "All types") jobs = jobs.filter((j) => j.type === type);
    return { jobs, source };
  };
  const scored = (jobs: Job[], resume: string, role: string) => jobs.map((j) => ({ ...j, ...scoreJob(resume, role, j) })).sort((a, b) => (b.match ?? 0) - (a.match ?? 0));

  const tailor = async (user: User, job: Job, resume: string): Promise<Tailoring & { match: number }> => {
    const { match, matchedSkills } = scoreJob(resume, getProfile(user.id).targetRole, job);
    const generated = await llmTailoring(resume, user.name, job, env, fetchImpl);
    return { ...(generated ?? templateTailoring(resume, user.name, job, matchedSkills)), match };
  };

  // ---- Health & auth
  app.get("/api/health", (_req, res) => res.json({ ok: true, database: "sqlite", jobSource: env.JOB_SOURCE ?? "remotive", ai: env.AI_PROVIDER === "groq" && env.GROQ_API_KEY ? "groq" : env.AI_PROVIDER === "ollama" && env.OLLAMA_MODEL ? "ollama" : "template", submissionMode: env.SUBMISSION_MODE ?? "manual" }));

  app.post("/api/auth/signup", async (req, res) => {
    const email = str(req.body?.email, 200).toLowerCase(); const password = String(req.body?.password ?? ""); const name = str(req.body?.name, 100);
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || !name) { res.status(400).json({ error: "Name, valid email, and password of at least 8 characters are required" }); return; }
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) { res.status(409).json({ error: "An account with that email already exists" }); return; }
    const result = db.prepare("INSERT INTO users (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)").run(email, await bcrypt.hash(password, 12), name, now());
    const id = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)").run(id, now());
    log(id, "Requirements", "Account created");
    res.status(201).json({ token: newSession(id), user: { id, email, name } });
  });
  app.post("/api/auth/login", async (req, res) => {
    const email = str(req.body?.email, 200).toLowerCase(); const password = String(req.body?.password ?? "");
    const key = `${email}|${req.ip}`; const f = failures.get(key);
    if (f && f.n >= 8 && f.until > Date.now()) { res.status(429).json({ error: "Too many attempts. Try again in a few minutes." }); return; }
    const row = db.prepare("SELECT id, email, name, password_hash AS hash FROM users WHERE email = ?").get(email) as (User & { hash: string }) | undefined;
    if (!row || !(await bcrypt.compare(password, row.hash))) { failures.set(key, { n: (f?.n ?? 0) + 1, until: Date.now() + 10 * 60_000 }); res.status(401).json({ error: "Invalid email or password" }); return; }
    failures.delete(key);
    res.json({ token: newSession(row.id), user: { id: row.id, email: row.email, name: row.name } });
  });
  app.get("/api/auth/me", auth, (_req, res) => res.json({ user: res.locals.user }));
  app.post("/api/auth/logout", (req, res) => { db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(bearer(req))); res.status(204).end(); });

  // ---- Profile
  app.get("/api/profile", auth, (_req, res) => res.json({ profile: getProfile(uid(res)) }));
  app.put("/api/profile", auth, (req, res) => {
    const cur = getProfile(uid(res)); const b = req.body ?? {};
    const next = { targetRole: b.targetRole !== undefined ? str(b.targetRole, 120) : cur.targetRole, jobType: b.jobType !== undefined ? str(b.jobType, 30) : cur.jobType, location: b.location !== undefined ? str(b.location, 120) : cur.location, resumeText: b.resumeText !== undefined ? String(b.resumeText).slice(0, 60000) : cur.resumeText, resumeName: b.resumeName !== undefined ? str(b.resumeName, 200) : cur.resumeName };
    db.prepare("INSERT INTO profiles (user_id, target_role, job_type, location, resume_text, resume_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET target_role = excluded.target_role, job_type = excluded.job_type, location = excluded.location, resume_text = excluded.resume_text, resume_name = excluded.resume_name, updated_at = excluded.updated_at").run(uid(res), next.targetRole, next.jobType, next.location, next.resumeText, next.resumeName, now());
    if (b.resumeText !== undefined && next.resumeText !== cur.resumeText) log(uid(res), "Requirements", `Resume updated (${next.resumeText.split(/\s+/).filter(Boolean).length} words)`);
    res.json({ profile: next });
  });

  // ---- Jobs
  app.get("/api/jobs", async (req, res) => {
    const query = str(req.query.query, 100); const type = str(req.query.type, 30) || "All types";
    const { jobs, source } = await loadJobs(query, type);
    const user = optionalUser(req);
    const profile = user ? getProfile(user.id) : undefined;
    const saved = user ? (db.prepare("SELECT job_id FROM saved_jobs WHERE user_id = ?").all(user.id) as Array<{ job_id: number }>).map((r) => r.job_id) : [];
    res.json({ source, saved, jobs: scored(jobs, profile?.resumeText ?? "", profile?.targetRole ?? query).slice(0, 40) });
  });
  app.put("/api/saved-jobs/:jobId", auth, (req, res) => { db.prepare("INSERT OR IGNORE INTO saved_jobs (user_id, job_id) VALUES (?, ?)").run(uid(res), Number(req.params.jobId)); res.status(204).end(); });
  app.delete("/api/saved-jobs/:jobId", auth, (req, res) => { db.prepare("DELETE FROM saved_jobs WHERE user_id = ? AND job_id = ?").run(uid(res), Number(req.params.jobId)); res.status(204).end(); });

  // ---- Applications
  app.get("/api/applications", auth, (_req, res) => res.json({ applications: listApps(uid(res)) }));
  app.post("/api/applications", auth, async (req, res) => {
    const job = sanitizeJob(req.body?.job);
    if (!job) { res.status(400).json({ error: "A valid job object is required" }); return; }
    const user = res.locals.user as User; const existing = db.prepare("SELECT * FROM applications WHERE user_id = ? AND job_id = ?").get(user.id, job.id) as AppRow | undefined;
    if (existing) { res.json(toApp(existing)); return; }
    const resume = getProfile(user.id).resumeText;
    const t = resume.trim() ? await tailor(user, job, resume) : { ...templateTailoring("", user.name, job, []), match: 0 };
    const r = db.prepare("INSERT INTO applications (user_id, job_id, job_json, status, match, summary, cover_letter, generated_by, created_at, updated_at) VALUES (?, ?, ?, 'Review', ?, ?, ?, ?, ?, ?)").run(user.id, job.id, JSON.stringify(job), t.match, t.summary, t.coverLetter, t.generatedBy, now(), now());
    const id = Number(r.lastInsertRowid);
    log(user.id, "Tailoring", `Drafted application for ${job.role} at ${job.company} (${t.generatedBy})`, id);
    log(user.id, "Review", `${job.role} at ${job.company} is waiting for your review`, id);
    res.status(201).json(toApp(ownApp(user.id, id)!));
  });
  app.patch("/api/applications/:id", auth, (req, res) => {
    const row = ownApp(uid(res), req.params.id);
    if (!row) { res.status(404).json({ error: "Application not found" }); return; }
    const b = req.body ?? {};
    if (b.status !== undefined && !(STATUSES as readonly string[]).includes(b.status)) { res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` }); return; }
    if (b.status && b.status !== row.status) {
      if (b.status !== "Review" && row.status === "Review" && b.status !== "Rejected") { res.status(409).json({ error: "Approve and submit the application before moving it further" }); return; }
      log(uid(res), b.status === "Interview" || b.status === "Offer" || b.status === "Rejected" ? "Outcome" : "Review", `${(JSON.parse(row.job_json) as Job).company}: ${row.status} → ${b.status}`, row.id);
    }
    db.prepare("UPDATE applications SET status = ?, summary = ?, cover_letter = ?, updated_at = ? WHERE id = ?").run(b.status ?? row.status, b.summary !== undefined ? str(b.summary, 8000) : row.summary, b.coverLetter !== undefined ? str(b.coverLetter, 8000) : row.cover_letter, now(), row.id);
    res.json(toApp(ownApp(uid(res), row.id)!));
  });
  app.delete("/api/applications/:id", auth, (req, res) => { db.prepare("DELETE FROM applications WHERE id = ? AND user_id = ?").run(Number(req.params.id), uid(res)); res.status(204).end(); });

  /** Approval gate: nothing is marked Submitted unless the user explicitly confirms they applied (manual) or the adapter is mock. */
  app.post("/api/applications/:id/submit", auth, (req, res) => {
    const row = ownApp(uid(res), req.params.id);
    if (!row) { res.status(404).json({ error: "Application not found" }); return; }
    const job = JSON.parse(row.job_json) as Job;
    if (row.status !== "Review") { res.json(toApp(row)); return; }
    const mode = env.SUBMISSION_MODE ?? "manual";
    if (mode !== "mock" && req.body?.confirmed !== true) { res.json({ requiresConfirmation: true, applyUrl: job.url ?? null, application: toApp(row) }); return; }
    const t = now();
    db.prepare("UPDATE applications SET status = 'Submitted', submitted_at = ?, updated_at = ? WHERE id = ?").run(t, t, row.id);
    log(uid(res), "Submission", `${job.role} at ${job.company} marked submitted${mode === "mock" ? " (mock adapter)" : " after your confirmation"}`, row.id);
    res.json(toApp(ownApp(uid(res), row.id)!));
  });

  // ---- Tailoring (regenerate for an existing application, or preview for any job)
  app.post("/api/tailor", auth, async (req, res) => {
    const user = res.locals.user as User; const profile = getProfile(user.id);
    const resume = str(req.body?.sourceResume, 60000) || profile.resumeText;
    if (!resume.trim()) { res.status(400).json({ error: "Add your resume first" }); return; }
    const row = req.body?.applicationId ? ownApp(user.id, req.body.applicationId) : undefined;
    const job = row ? (JSON.parse(row.job_json) as Job) : sanitizeJob(req.body?.job);
    if (!job) { res.status(400).json({ error: "applicationId or job is required" }); return; }
    const t = await tailor(user, job, resume);
    if (row) {
      db.prepare("UPDATE applications SET summary = ?, cover_letter = ?, generated_by = ?, match = ?, updated_at = ? WHERE id = ?").run(t.summary, t.coverLetter, t.generatedBy, t.match, now(), row.id);
      log(user.id, "Tailoring", `Regenerated draft for ${job.company} (${t.generatedBy})`, row.id);
    }
    res.json(t);
  });

  // ---- The agent: discover → score → tailor → queue for human review
  app.post("/api/agent/run", auth, async (req, res) => {
    const user = res.locals.user as User; const profile = getProfile(user.id);
    if (profile.resumeText.trim().split(/\s+/).length < 20) { res.status(400).json({ error: "Add your resume (at least a short summary) in Resume studio so the agent can match and tailor honestly." }); return; }
    const query = str(req.body?.query, 100) || profile.targetRole; const type = str(req.body?.type, 30) || profile.jobType || "All types";
    const limit = Math.min(10, Math.max(1, Number(req.body?.limit) || 3)); const minMatch = Math.min(95, Math.max(0, Number(req.body?.minMatch ?? 55)));
    const { jobs, source } = await loadJobs(query, type);
    const ranked = scored(jobs, profile.resumeText, profile.targetRole || query);
    const have = new Set((db.prepare("SELECT job_id FROM applications WHERE user_id = ?").all(user.id) as Array<{ job_id: number }>).map((r) => r.job_id));
    const candidates = ranked.filter((j) => !have.has(j.id) && (j.match ?? 0) >= minMatch).slice(0, limit);
    log(user.id, "Discovery", `Searched ${source} for “${query}” (${type}): ${jobs.length} listings, ${candidates.length} above ${minMatch}% match`);
    const queued = [] as ReturnType<typeof toApp>[];
    for (const job of candidates) {
      const { match: _m, matchedSkills: _s, ...clean } = job; void _m; void _s;
      const t = await tailor(user, clean, profile.resumeText);
      const r = db.prepare("INSERT INTO applications (user_id, job_id, job_json, status, match, summary, cover_letter, generated_by, created_at, updated_at) VALUES (?, ?, ?, 'Review', ?, ?, ?, ?, ?, ?)").run(user.id, job.id, JSON.stringify(clean), job.match ?? 0, t.summary, t.coverLetter, t.generatedBy, now(), now());
      const id = Number(r.lastInsertRowid);
      log(user.id, "Tailoring", `Drafted application for ${job.role} at ${job.company} — ${job.match}% match (${t.generatedBy})`, id);
      log(user.id, "Review", `${job.role} at ${job.company} queued for your approval`, id);
      queued.push(toApp(ownApp(user.id, id)!));
    }
    db.prepare("INSERT INTO agent_runs (user_id, query, found, considered, queued, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(user.id, query, jobs.length, ranked.length, queued.length, source, now());
    res.json({ query, type, source, found: jobs.length, minMatch, queued, skipped: ranked.filter((j) => have.has(j.id)).length, belowThreshold: ranked.filter((j) => !have.has(j.id) && (j.match ?? 0) < minMatch).length });
  });

  // ---- SDLC reports
  const buildReport = (user: User) => {
    const profile = getProfile(user.id); const apps = listApps(user.id);
    const runs = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(found), 0) AS found FROM agent_runs WHERE user_id = ?").get(user.id) as { n: number; found: number };
    const count = (s: Status[]) => apps.filter((a) => s.includes(a.status)).length;
    const words = profile.resumeText.split(/\s+/).filter(Boolean).length;
    const bySource: Record<string, number> = {}; const byAi: Record<string, number> = {};
    apps.forEach((a) => { bySource[a.job.source] = (bySource[a.job.source] ?? 0) + 1; byAi[a.generatedBy] = (byAi[a.generatedBy] ?? 0) + 1; });
    const review = count(["Review"]); const submitted = count(["Submitted", "Interview", "Offer", "Rejected"]); const outcomes = count(["Interview", "Offer"]);
    const stages = [
      { name: "Requirements", status: profile.targetRole && words >= 20 ? "complete" : "active", count: words, detail: `${words} resume words · target “${profile.targetRole || "not set"}”` },
      { name: "Discovery", status: runs.n ? "complete" : "pending", count: runs.found, detail: `${runs.n} agent run${runs.n === 1 ? "" : "s"} scanned ${runs.found} listings` },
      { name: "Tailoring", status: apps.length ? "complete" : "pending", count: apps.length, detail: `${apps.filter((a) => a.summary).length} drafts generated` },
      { name: "Review", status: review ? "active" : apps.length ? "complete" : "pending", count: review, detail: `${review} awaiting your approval` },
      { name: "Submission", status: submitted ? (review ? "active" : "complete") : "pending", count: submitted, detail: `${submitted} marked submitted after confirmation` },
      { name: "Outcome", status: outcomes ? "complete" : "pending", count: outcomes, detail: `${outcomes} interview/offer · ${count(["Rejected"])} rejected` },
    ];
    const events = db.prepare("SELECT id, stage, message, created_at AS createdAt FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 30").all(user.id);
    const avgMatch = apps.length ? Math.round(apps.reduce((a, b) => a + b.match, 0) / apps.length) : 0;
    return { generatedAt: now(), owner: user, stages, totals: { applications: apps.length, review, submitted, outcomes, agentRuns: runs.n, avgMatch }, bySource, byAi, events };
  };
  app.get("/api/reports", auth, (_req, res) => res.json(buildReport(res.locals.user as User)));
  app.get("/api/reports/export", auth, (_req, res) => {
    const r = buildReport(res.locals.user as User);
    const md = [`# Orbit SDLC report`, `Generated ${r.generatedAt} for ${r.owner.name}`, ``, `## Totals`, ...Object.entries(r.totals).map(([k, v]) => `- ${k}: ${v}`), ``, `## Stages`, ...r.stages.map((s) => `- **${s.name}** (${s.status}): ${s.detail}`), ``, `## Recent activity`, ...r.events.map((e) => `- ${(e as { createdAt: string }).createdAt} · ${(e as { stage: string }).stage} · ${(e as { message: string }).message}`)].join("\n");
    res.type("text/markdown").send(md);
  });

  app.use("/api", (_req, res) => { res.status(404).json({ error: "Not found" }); });
  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => (req.method === "GET" ? res.sendFile(path.resolve(staticDir, "index.html")) : next()));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { console.error(error); res.status(500).json({ error: "Internal server error" }); });
  return app;
}
