import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { EMPTY_PROFILE, HttpError, STATUSES, createCore } from "../shared/core.ts";
import type { ActivityEvent, Application, Profile, Status, Store, User } from "../shared/core.ts";
import type { Env, Job } from "../shared/lib.ts";

export { STATUSES };
type Db = InstanceType<typeof Database>;
type AppRow = { id: number; user_id: number; job_id: number; job_json: string; status: Status; match: number; summary: string; cover_letter: string; generated_by: string; created_at: string; updated_at: string; submitted_at: string | null };

export type AppOptions = { db: Db; env?: Env; fetchImpl?: typeof fetch; getJobs?: (query: string) => Promise<Job[]>; staticDir?: string };

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
    CREATE TABLE IF NOT EXISTS saved_jobs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_id INTEGER NOT NULL, job_json TEXT, PRIMARY KEY (user_id, job_id));
    CREATE TABLE IF NOT EXISTS agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, query TEXT NOT NULL, found INTEGER NOT NULL, considered INTEGER NOT NULL, queued INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, application_id INTEGER, stage TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  // Databases created before saved jobs kept their listing details only stored the id.
  const savedCols = db.prepare("PRAGMA table_info(saved_jobs)").all() as Array<{ name: string }>;
  if (!savedCols.some((c) => c.name === "job_json")) db.exec("ALTER TABLE saved_jobs ADD COLUMN job_json TEXT");
  return db;
}

const now = () => new Date().toISOString();
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const toApp = (r: AppRow): Application => ({ id: r.id, jobId: r.job_id, job: JSON.parse(r.job_json) as Job, status: r.status, match: r.match, summary: r.summary, coverLetter: r.cover_letter, generatedBy: r.generated_by, createdAt: r.created_at, updatedAt: r.updated_at, submittedAt: r.submitted_at });

/** One user's rows. Every statement is scoped by user_id, so a user can never reach another user's records. */
function sqliteStore(db: Db, userId: number): Store {
  const getApplication = (id: number) => { const r = db.prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?").get(id, userId) as AppRow | undefined; return r && toApp(r); };
  return {
    getProfile: () => (db.prepare("SELECT target_role AS targetRole, job_type AS jobType, location, resume_text AS resumeText, resume_name AS resumeName FROM profiles WHERE user_id = ?").get(userId) as Profile | undefined) ?? { ...EMPTY_PROFILE },
    saveProfile: (p) => { db.prepare("INSERT INTO profiles (user_id, target_role, job_type, location, resume_text, resume_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET target_role = excluded.target_role, job_type = excluded.job_type, location = excluded.location, resume_text = excluded.resume_text, resume_name = excluded.resume_name, updated_at = excluded.updated_at").run(userId, p.targetRole, p.jobType, p.location, p.resumeText, p.resumeName, now()); },
    listApplications: () => (db.prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY id DESC").all(userId) as AppRow[]).map(toApp),
    getApplication,
    findApplicationByJob: (jobId) => { const r = db.prepare("SELECT * FROM applications WHERE user_id = ? AND job_id = ?").get(userId, jobId) as AppRow | undefined; return r && toApp(r); },
    insertApplication: (a) => {
      const r = db.prepare("INSERT INTO applications (user_id, job_id, job_json, status, match, summary, cover_letter, generated_by, created_at, updated_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(userId, a.jobId, JSON.stringify(a.job), a.status, a.match, a.summary, a.coverLetter, a.generatedBy, a.createdAt, a.updatedAt, a.submittedAt);
      return getApplication(Number(r.lastInsertRowid))!;
    },
    updateApplication: (id, patch) => {
      const cur = getApplication(id);
      if (!cur) throw new HttpError(404, "Application not found");
      const next = { ...cur, ...patch };
      db.prepare("UPDATE applications SET status = ?, match = ?, summary = ?, cover_letter = ?, generated_by = ?, updated_at = ?, submitted_at = ? WHERE id = ? AND user_id = ?").run(next.status, next.match, next.summary, next.coverLetter, next.generatedBy, next.updatedAt, next.submittedAt, id, userId);
      return getApplication(id)!;
    },
    deleteApplication: (id) => { db.prepare("DELETE FROM applications WHERE id = ? AND user_id = ?").run(id, userId); },
    savedJobIds: () => (db.prepare("SELECT job_id FROM saved_jobs WHERE user_id = ?").all(userId) as Array<{ job_id: number }>).map((r) => r.job_id),
    savedJobs: () => (db.prepare("SELECT job_json FROM saved_jobs WHERE user_id = ? AND job_json IS NOT NULL").all(userId) as Array<{ job_json: string }>).map((r) => JSON.parse(r.job_json) as Job),
    setSaved: (jobId, saved, job) => {
      if (saved) db.prepare("INSERT INTO saved_jobs (user_id, job_id, job_json) VALUES (?, ?, ?) ON CONFLICT(user_id, job_id) DO UPDATE SET job_json = COALESCE(excluded.job_json, saved_jobs.job_json)").run(userId, jobId, job ? JSON.stringify(job) : null);
      else db.prepare("DELETE FROM saved_jobs WHERE user_id = ? AND job_id = ?").run(userId, jobId);
    },
    addRun: (r) => { db.prepare("INSERT INTO agent_runs (user_id, query, found, considered, queued, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, r.query, r.found, r.considered, r.queued, r.source, r.createdAt); },
    runStats: () => db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(found), 0) AS found FROM agent_runs WHERE user_id = ?").get(userId) as { n: number; found: number },
    addEvent: (stage, message, applicationId) => { db.prepare("INSERT INTO events (user_id, application_id, stage, message, created_at) VALUES (?, ?, ?, ?, ?)").run(userId, applicationId ?? null, stage, message, now()); },
    recentEvents: (limit) => db.prepare("SELECT id, stage, message, created_at AS createdAt FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit) as ActivityEvent[],
  };
}

export function createApp({ db, env = process.env, fetchImpl, getJobs, staticDir }: AppOptions) {
  const core = createCore({ env: () => env, fetchImpl, getJobs });
  const app = express();
  app.disable("x-powered-by");
  // The UI is normally served from this same origin. CORS_ORIGINS lets a separately hosted UI (e.g. GitHub Pages) call the API.
  const extraOrigins = (env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
  app.use(cors({ origin: [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, ...extraOrigins] }));
  app.use(express.json({ limit: "2mb" }));
  app.use((_req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); next(); });

  const failures = new Map<string, { n: number; until: number }>();
  const SESSION_USER = "SELECT u.id, u.email, u.name FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?";
  const bearer = (req: Request) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const optionalUser = (req: Request): User | undefined => {
    const token = bearer(req);
    return token ? (db.prepare(SESSION_USER).get(hashToken(token), now()) as User | undefined) : undefined;
  };
  const auth = (req: Request, res: Response, next: NextFunction) => {
    const user = optionalUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
    res.locals.user = user;
    next();
  };
  const me = (res: Response) => res.locals.user as User;
  const store = (res: Response) => sqliteStore(db, me(res).id);
  const newSession = (userId: number) => {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hashToken(token), userId, now(), new Date(Date.now() + 14 * 864e5).toISOString());
    return token;
  };

  // ---- Health & auth
  app.get("/api/health", (_req, res) => res.json({ ...core.health(), database: "sqlite" }));

  app.post("/api/auth/signup", async (req, res) => {
    const email = str(req.body?.email, 200).toLowerCase(); const password = String(req.body?.password ?? ""); const name = str(req.body?.name, 100);
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || !name) { res.status(400).json({ error: "Name, valid email, and password of at least 8 characters are required" }); return; }
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) { res.status(409).json({ error: "An account with that email already exists" }); return; }
    const result = db.prepare("INSERT INTO users (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)").run(email, await bcrypt.hash(password, 12), name, now());
    const id = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)").run(id, now());
    sqliteStore(db, id).addEvent("Requirements", "Account created");
    res.status(201).json({ token: newSession(id), user: { id, email, name } });
  });
  app.post("/api/auth/login", async (req, res) => {
    const email = str(req.body?.email, 200).toLowerCase(); const password = String(req.body?.password ?? "");
    const key = `${email}|${req.ip}`; const f = failures.get(key);
    if (f && f.n >= 8 && f.until > Date.now()) { res.status(429).json({ error: "Too many attempts. Try again in a few minutes." }); return; }
    const row = db.prepare("SELECT id, email, name, password_hash AS hash FROM users WHERE email = ?").get(email) as (User & { hash: string }) | undefined;
    if (!row || !(await bcrypt.compare(password, row.hash))) {
      if (failures.size > 5000) for (const [k, v] of failures) if (v.until <= Date.now()) failures.delete(k);
      failures.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 10 * 60_000 });
      res.status(401).json({ error: "Invalid email or password" }); return;
    }
    failures.delete(key);
    res.json({ token: newSession(row.id), user: { id: row.id, email: row.email, name: row.name } });
  });
  app.get("/api/auth/me", auth, (_req, res) => res.json({ user: me(res) }));
  app.post("/api/auth/logout", (req, res) => { db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(bearer(req))); res.status(204).end(); });
  /** Permanently removes the account and, through ON DELETE CASCADE, every record that belongs to it. */
  app.delete("/api/account", auth, async (req, res) => {
    const row = db.prepare("SELECT password_hash AS hash FROM users WHERE id = ?").get(me(res).id) as { hash: string };
    if (!(await bcrypt.compare(String(req.body?.password ?? ""), row.hash))) { res.status(403).json({ error: "Enter your current password to delete the account" }); return; }
    db.prepare("DELETE FROM users WHERE id = ?").run(me(res).id);
    res.status(204).end();
  });

  // ---- Profile
  app.get("/api/profile", auth, (_req, res) => res.json({ profile: store(res).getProfile() }));
  app.put("/api/profile", auth, (req, res) => res.json({ profile: core.saveProfile(store(res), req.body) }));

  // ---- Jobs
  app.get("/api/jobs", async (req, res) => {
    const user = optionalUser(req);
    res.json(await core.searchJobs(user ? sqliteStore(db, user.id) : undefined, req.query.query, req.query.type));
  });
  app.get("/api/saved-jobs", auth, (_req, res) => res.json(core.savedJobs(store(res))));
  app.put("/api/saved-jobs/:jobId", auth, (req, res) => { core.setSaved(store(res), req.params.jobId, true, req.body?.job); res.status(204).end(); });
  app.delete("/api/saved-jobs/:jobId", auth, (req, res) => { core.setSaved(store(res), req.params.jobId, false); res.status(204).end(); });

  // ---- Applications
  app.get("/api/applications", auth, (_req, res) => res.json({ applications: store(res).listApplications() }));
  app.post("/api/applications", auth, async (req, res) => {
    const { application, created } = await core.createApplication(store(res), me(res), req.body);
    res.status(created ? 201 : 200).json(application);
  });
  app.patch("/api/applications/:id", auth, (req, res) => res.json(core.updateApplication(store(res), req.params.id, req.body)));
  app.delete("/api/applications/:id", auth, (req, res) => { core.deleteApplication(store(res), req.params.id); res.status(204).end(); });
  app.post("/api/applications/:id/submit", auth, (req, res) => res.json(core.submitApplication(store(res), req.params.id, req.body)));

  // ---- Tailoring, the agent, reports
  app.post("/api/tailor", auth, async (req, res) => res.json(await core.tailor(store(res), me(res), req.body)));
  app.post("/api/agent/run", auth, async (req, res) => res.json(await core.runAgent(store(res), me(res), req.body)));
  app.get("/api/reports", auth, (_req, res) => res.json(core.report(store(res), me(res))));
  app.get("/api/reports/export", auth, (_req, res) => res.type("text/markdown").send(core.reportMarkdown(store(res), me(res))));

  app.use("/api", (_req, res) => { res.status(404).json({ error: "Not found" }); });
  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    // Client-side routes get the app shell; a missing asset stays a 404 instead of silently returning HTML.
    app.use((req, res, next) => (req.method === "GET" && !path.extname(req.path) ? res.sendFile(path.resolve(staticDir, "index.html")) : next()));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof HttpError ? error.status : Number((error as { status?: unknown } | null)?.status);
    if (status >= 400 && status < 500) { res.status(status).json({ error: error instanceof HttpError ? error.message : "Invalid request" }); return; }
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}
