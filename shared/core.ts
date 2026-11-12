/**
 * Orbit's business rules, independent of where data lives.
 * The Express server runs this over SQLite; the browser-only build runs the same code over localStorage,
 * so the approval gate and the resume-only tailoring behave identically in both.
 */
import { DEMO_JOBS, fetchJobicy, fetchRemotive, llmTailoring, locationFits, matchesQuery, scoreJob, templateTailoring } from "./lib.ts";
import type { Env, Job, Tailoring } from "./lib.ts";

export const STATUSES = ["Review", "Submitted", "Interview", "Offer", "Rejected"] as const;
export type Status = (typeof STATUSES)[number];
export type User = { id: number; email: string; name: string };
export type Profile = { targetRole: string; jobType: string; location: string; resumeText: string; resumeName: string };
export type Application = { id: number; jobId: number; job: Job; status: Status; match: number; summary: string; coverLetter: string; generatedBy: string; createdAt: string; updatedAt: string; submittedAt: string | null };
export type ApplicationPatch = Partial<Pick<Application, "status" | "match" | "summary" | "coverLetter" | "generatedBy" | "updatedAt" | "submittedAt">>;
export type ActivityEvent = { id: number; stage: string; message: string; createdAt: string };
export type AgentRun = { query: string; found: number; considered: number; queued: number; source: string; createdAt: string };
export type SubmitResult = Application | { requiresConfirmation: true; applyUrl: string | null; application: Application };

export const EMPTY_PROFILE: Profile = { targetRole: "", jobType: "All types", location: "", resumeText: "", resumeName: "" };

/** Everything the rules need from storage, already scoped to one user. */
export interface Store {
  getProfile(): Profile;
  saveProfile(profile: Profile): void;
  /** Newest first. */
  listApplications(): Application[];
  getApplication(id: number): Application | undefined;
  findApplicationByJob(jobId: number): Application | undefined;
  insertApplication(app: Omit<Application, "id">): Application;
  updateApplication(id: number, patch: ApplicationPatch): Application;
  deleteApplication(id: number): void;
  savedJobIds(): number[];
  /** Saved jobs whose listing details were stored. */
  savedJobs(): Job[];
  setSaved(jobId: number, saved: boolean, job?: Job): void;
  addRun(run: AgentRun): void;
  runStats(): { n: number; found: number };
  addEvent(stage: string, message: string, applicationId?: number): void;
  /** Newest first. */
  recentEvents(limit: number): ActivityEvent[];
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type CoreOptions = { env: () => Env; fetchImpl?: typeof fetch; getJobs?: (query: string) => Promise<Job[]> };
export type Core = ReturnType<typeof createCore>;

type Body = Record<string, unknown>;
const now = () => new Date().toISOString();
const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const asBody = (v: unknown): Body => (v && typeof v === "object" ? (v as Body) : {});
const clamp = (v: unknown, min: number, max: number, fallback: number) => { const n = Number(v ?? fallback); return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback)); };

export function sanitizeJob(raw: unknown): Job | null {
  const j = raw as Partial<Job> | undefined;
  if (!j || !Number.isFinite(Number(j.id)) || !j.company || !j.role) return null;
  return { id: Number(j.id), company: str(j.company, 120), role: str(j.role, 160), type: str(j.type, 40) || "Unspecified", location: str(j.location, 120) || "Remote", salary: str(j.salary, 80) || "Salary not listed", skills: Array.isArray(j.skills) ? j.skills.slice(0, 10).map((s) => str(s, 40)) : [], url: typeof j.url === "string" && /^https?:\/\//.test(j.url) ? str(j.url, 500) : undefined, source: str(j.source, 40) || "unknown", description: str(j.description, 3000), posted: str(j.posted, 30) || "recent" };
}

export const aiLabel = (env: Env) => (env.AI_PROVIDER === "groq" && env.GROQ_API_KEY ? "groq" : env.AI_PROVIDER === "ollama" && env.OLLAMA_MODEL ? "ollama" : "template");

export function createCore({ env, fetchImpl, getJobs }: CoreOptions) {
  // Wrapped so the browser's fetch is never called detached from window.
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));

  /** JOB_SOURCE: all (default) = every live feed, remotive | jobicy = just that one, demo = the built-in samples. */
  const liveSources = (): Array<{ name: string; load: (query: string) => Promise<Job[]> }> => {
    const wanted = (env().JOB_SOURCE ?? "all").toLowerCase();
    const all = [{ name: "Remotive", load: () => fetchRemotive(doFetch) }, { name: "Jobicy", load: (query: string) => fetchJobicy(query, doFetch) }];
    return wanted === "demo" ? [] : wanted === "all" ? all : all.filter((s) => s.name.toLowerCase() === wanted);
  };
  const loadJobs = async (query: string, type: string) => {
    let jobs: Job[] = [];
    let source = "demo";
    if (getJobs) { jobs = await getJobs(query); source = jobs[0]?.source ?? "custom"; }
    else {
      const sources = liveSources();
      const answers = await Promise.allSettled(sources.map((s) => s.load(query)));
      const reached: string[] = []; const seen = new Set<string>();
      answers.forEach((answer, i) => {
        if (answer.status === "rejected") { console.warn(`${sources[i].name} unavailable:`, answer.reason instanceof Error ? answer.reason.message : answer.reason); return; }
        reached.push(sources[i].name);
        // The feeds do not all honour the search themselves, and the same opening can be on both.
        for (const job of answer.value) {
          const key = `${job.company}|${job.role}`.toLowerCase();
          if (seen.has(key) || !matchesQuery(job, query)) continue;
          seen.add(key); jobs.push(job);
        }
      });
      if (reached.length) source = reached.join(" + ");
      else { const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2); jobs = DEMO_JOBS.filter((j) => !words.length || words.some((w) => `${j.role} ${j.company} ${j.skills.join(" ")}`.toLowerCase().includes(w))); }
    }
    if (type && type !== "All types") jobs = jobs.filter((j) => j.type === type);
    return { jobs, source };
  };
  /** Ranked by resume match. When the profile names a place, each listing also says whether it is open to candidates there. */
  const scored = (jobs: Job[], profile: Pick<Profile, "resumeText" | "location"> | undefined, role: string) => jobs.map((j) => {
    const fit = profile ? locationFits(j.location, profile.location) : undefined;
    return { ...j, ...scoreJob(profile?.resumeText ?? "", role, j), ...(fit === undefined ? {} : { locationFit: fit }) };
  }).sort((a, b) => b.match - a.match);

  const tailorJob = async (store: Store, user: User, job: Job, resume: string): Promise<Tailoring & { match: number }> => {
    const { match, matchedSkills } = scoreJob(resume, store.getProfile().targetRole, job);
    const generated = await llmTailoring(resume, user.name, job, env(), doFetch);
    return { ...(generated ?? templateTailoring(resume, user.name, job, matchedSkills)), match };
  };
  const queue = (store: Store, job: Job, t: Tailoring, match: number) => {
    const at = now();
    return store.insertApplication({ jobId: job.id, job, status: "Review", match, summary: t.summary, coverLetter: t.coverLetter, generatedBy: t.generatedBy, createdAt: at, updatedAt: at, submittedAt: null });
  };
  const mustGet = (store: Store, id: unknown) => {
    const app = store.getApplication(Number(id));
    if (!app) throw new HttpError(404, "Application not found");
    return app;
  };

  const report = (store: Store, user: User) => {
    const profile = store.getProfile(); const apps = store.listApplications(); const runs = store.runStats();
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
    const avgMatch = apps.length ? Math.round(apps.reduce((a, b) => a + b.match, 0) / apps.length) : 0;
    return { generatedAt: now(), owner: user, stages, totals: { applications: apps.length, review, submitted, outcomes, agentRuns: runs.n, avgMatch }, bySource, byAi, events: store.recentEvents(30) };
  };

  return {
    health: () => { const e = env(); return { ok: true, jobSource: e.JOB_SOURCE ?? "all", ai: aiLabel(e), submissionMode: e.SUBMISSION_MODE ?? "manual" }; },

    /** Listings for a search, ranked against the signed-in user's resume when there is one. */
    async searchJobs(store: Store | undefined, rawQuery: unknown, rawType: unknown) {
      const query = str(rawQuery, 100); const type = str(rawType, 30) || "All types";
      const { jobs, source } = await loadJobs(query, type);
      const profile = store?.getProfile();
      return { source, saved: store?.savedJobIds() ?? [], jobs: scored(jobs, profile, profile?.targetRole || query).slice(0, 40) };
    },

    savedJobs(store: Store) {
      const profile = store.getProfile();
      return { jobs: scored(store.savedJobs(), profile, profile.targetRole) };
    },
    setSaved(store: Store, rawJobId: unknown, saved: boolean, rawJob?: unknown) {
      const jobId = Number(rawJobId);
      if (!Number.isFinite(jobId)) throw new HttpError(400, "A numeric job id is required");
      const job = saved ? sanitizeJob(rawJob) : null;
      store.setSaved(jobId, saved, job && job.id === jobId ? job : undefined);
    },

    saveProfile(store: Store, body: unknown): Profile {
      const cur = store.getProfile(); const b = asBody(body);
      const next: Profile = { targetRole: b.targetRole !== undefined ? str(b.targetRole, 120) : cur.targetRole, jobType: b.jobType !== undefined ? str(b.jobType, 30) : cur.jobType, location: b.location !== undefined ? str(b.location, 120) : cur.location, resumeText: b.resumeText !== undefined ? String(b.resumeText).slice(0, 60000) : cur.resumeText, resumeName: b.resumeName !== undefined ? str(b.resumeName, 200) : cur.resumeName };
      store.saveProfile(next);
      if (next.resumeText !== cur.resumeText) store.addEvent("Requirements", `Resume updated (${next.resumeText.split(/\s+/).filter(Boolean).length} words)`);
      return next;
    },

    /** Draft an application for one job the user picked. Returns the existing one if the job is already tracked. */
    async createApplication(store: Store, user: User, body: unknown): Promise<{ application: Application; created: boolean }> {
      const job = sanitizeJob(asBody(body).job);
      if (!job) throw new HttpError(400, "A valid job object is required");
      const existing = store.findApplicationByJob(job.id);
      if (existing) return { application: existing, created: false };
      const resume = store.getProfile().resumeText;
      const t = resume.trim() ? await tailorJob(store, user, job, resume) : { ...templateTailoring("", user.name, job, []), match: 0 };
      const application = queue(store, job, t, t.match);
      store.addEvent("Tailoring", `Drafted application for ${job.role} at ${job.company} (${t.generatedBy})`, application.id);
      store.addEvent("Review", `${job.role} at ${job.company} is waiting for your review`, application.id);
      return { application, created: true };
    },

    updateApplication(store: Store, id: unknown, body: unknown): Application {
      const app = mustGet(store, id); const b = asBody(body);
      const status = b.status as Status | undefined;
      if (b.status !== undefined && !(STATUSES as readonly unknown[]).includes(b.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
      if (status && status !== app.status) {
        // The approval gate: a draft in Review can be rejected, but only /submit can move it forward.
        if (app.status === "Review" && status !== "Rejected") throw new HttpError(409, "Approve and submit the application before moving it further");
        store.addEvent(status === "Interview" || status === "Offer" || status === "Rejected" ? "Outcome" : "Review", `${app.job.company}: ${app.status} → ${status}`, app.id);
      }
      return store.updateApplication(app.id, { status: status ?? app.status, summary: b.summary !== undefined ? str(b.summary, 8000) : app.summary, coverLetter: b.coverLetter !== undefined ? str(b.coverLetter, 8000) : app.coverLetter, updatedAt: now() });
    },

    deleteApplication(store: Store, id: unknown) { store.deleteApplication(Number(id)); },

    /** Nothing is marked Submitted unless the user explicitly confirms they applied (manual) or the adapter is mock. */
    submitApplication(store: Store, id: unknown, body: unknown): SubmitResult {
      const app = mustGet(store, id);
      if (app.status !== "Review") return app;
      const mode = env().SUBMISSION_MODE ?? "manual";
      if (mode !== "mock" && asBody(body).confirmed !== true) return { requiresConfirmation: true, applyUrl: app.job.url ?? null, application: app };
      const at = now();
      const updated = store.updateApplication(app.id, { status: "Submitted", submittedAt: at, updatedAt: at });
      store.addEvent("Submission", `${app.job.role} at ${app.job.company} marked submitted${mode === "mock" ? " (mock adapter)" : " after your confirmation"}`, app.id);
      return updated;
    },

    /** Regenerate the draft of an existing application, or preview a draft for any job. */
    async tailor(store: Store, user: User, body: unknown): Promise<Tailoring & { match: number; application?: Application }> {
      const b = asBody(body);
      const resume = str(b.sourceResume, 60000) || store.getProfile().resumeText;
      if (!resume.trim()) throw new HttpError(400, "Add your resume first");
      const app = b.applicationId ? store.getApplication(Number(b.applicationId)) : undefined;
      const job = app ? app.job : sanitizeJob(b.job);
      if (!job) throw new HttpError(400, "applicationId or job is required");
      const t = await tailorJob(store, user, job, resume);
      if (!app) return t;
      const application = store.updateApplication(app.id, { summary: t.summary, coverLetter: t.coverLetter, generatedBy: t.generatedBy, match: t.match, updatedAt: now() });
      store.addEvent("Tailoring", `Regenerated draft for ${job.company} (${t.generatedBy})`, app.id);
      return { ...t, application };
    },

    /** The agent: discover → score → tailor → queue for human review. It never submits anything. */
    async runAgent(store: Store, user: User, body: unknown) {
      const b = asBody(body); const profile = store.getProfile();
      if (profile.resumeText.trim().split(/\s+/).length < 20) throw new HttpError(400, "Add your resume (at least a short summary) in Resume studio so the agent can match and tailor honestly.");
      const query = str(b.query, 100) || profile.targetRole; const type = str(b.type, 30) || profile.jobType || "All types";
      const limit = clamp(b.limit, 1, 10, 3); const minMatch = clamp(b.minMatch, 0, 95, 55);
      const { jobs, source } = await loadJobs(query, type);
      const ranked = scored(jobs, profile, profile.targetRole || query);
      const have = new Set(store.listApplications().map((a) => a.jobId));
      // Among listings above the threshold, those open to the user's location are drafted first; each group stays in match order.
      const eligible = ranked.filter((j) => !have.has(j.id) && j.match >= minMatch);
      const candidates = [...eligible.filter((j) => j.locationFit !== false), ...eligible.filter((j) => j.locationFit === false)].slice(0, limit);
      store.addEvent("Discovery", `Searched ${source} for “${query}” (${type}): ${jobs.length} listings, ${candidates.length} above ${minMatch}% match`);
      const queued: Application[] = [];
      for (const candidate of candidates) {
        const { match, matchedSkills: _skills, locationFit: _fit, ...job } = candidate; void _skills; void _fit;
        const t = await tailorJob(store, user, job, profile.resumeText);
        const application = queue(store, job, t, match);
        store.addEvent("Tailoring", `Drafted application for ${job.role} at ${job.company} — ${match}% match (${t.generatedBy})`, application.id);
        store.addEvent("Review", `${job.role} at ${job.company} queued for your approval`, application.id);
        queued.push(application);
      }
      store.addRun({ query, found: jobs.length, considered: ranked.length, queued: queued.length, source, createdAt: now() });
      return { query, type, source, found: jobs.length, minMatch, queued, skipped: ranked.filter((j) => have.has(j.id)).length, belowThreshold: ranked.filter((j) => !have.has(j.id) && j.match < minMatch).length };
    },

    report,

    reportMarkdown(store: Store, user: User): string {
      const r = report(store, user);
      return [`# Orbit SDLC report`, `Generated ${r.generatedAt} for ${r.owner.name}`, ``, `## Totals`, ...Object.entries(r.totals).map(([k, v]) => `- ${k}: ${v}`), ``, `## Stages`, ...r.stages.map((s) => `- **${s.name}** (${s.status}): ${s.detail}`), ``, `## Recent activity`, ...r.events.map((e) => `- ${e.createdAt} · ${e.stage} · ${e.message}`)].join("\n");
    },
  };
}
