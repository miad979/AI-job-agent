/**
 * The Orbit API implemented entirely in the browser, for static hosting (GitHub Pages) where there is no server.
 * One workspace per browser, stored in localStorage. It answers the same paths as the Express API by running
 * the same rules from core.ts, so the UI does not care which one it is talking to.
 */
import { EMPTY_PROFILE, HttpError, createCore } from "./core.ts";
import type { ActivityEvent, AgentRun, Application, Profile, Store, User } from "./core.ts";
import type { Job } from "./lib.ts";

export type KeyValueStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
export const LOCAL_STORAGE_KEY = "orbit-local-v1";
export const LOCAL_TOKEN = "local";
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
const MAX_EVENTS = 300;

type Data = {
  user: User | null; profile: Profile; applications: Application[]; saved: Array<{ jobId: number; job?: Job }>;
  runs: AgentRun[]; events: Array<ActivityEvent & { applicationId?: number }>; nextId: number; ai: { groqKey: string; groqModel: string };
};
const empty = (): Data => ({ user: null, profile: { ...EMPTY_PROFILE }, applications: [], saved: [], runs: [], events: [], nextId: 1, ai: { groqKey: "", groqModel: "" } });

export function createLocalBackend(storage: KeyValueStorage, options: { fetchImpl?: typeof fetch; getJobs?: (query: string) => Promise<Job[]> } = {}) {
  let data = empty();
  const load = () => {
    try { const raw = storage.getItem(LOCAL_STORAGE_KEY); data = raw ? { ...empty(), ...(JSON.parse(raw) as Partial<Data>) } : empty(); } catch { data = empty(); }
  };
  // Saved after every change, so a long agent run and a quick edit in the same tab never overwrite each other.
  const save = () => {
    try { storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data)); } catch { throw new HttpError(507, "This browser's storage is full or blocked, so the change could not be saved."); }
  };
  const nowIso = () => new Date().toISOString();
  const mustFind = (id: number) => {
    const index = data.applications.findIndex((a) => a.id === id);
    if (index < 0) throw new HttpError(404, "Application not found");
    return index;
  };

  const store: Store = {
    getProfile: () => ({ ...EMPTY_PROFILE, ...data.profile }),
    saveProfile: (profile) => { data.profile = profile; save(); },
    listApplications: () => [...data.applications].sort((a, b) => b.id - a.id),
    getApplication: (id) => data.applications.find((a) => a.id === id),
    findApplicationByJob: (jobId) => data.applications.find((a) => a.jobId === jobId),
    insertApplication: (app) => { const created = { ...app, id: data.nextId++ }; data.applications.push(created); save(); return created; },
    updateApplication: (id, patch) => { const index = mustFind(id); data.applications[index] = { ...data.applications[index], ...patch }; save(); return data.applications[index]; },
    deleteApplication: (id) => { data.applications = data.applications.filter((a) => a.id !== id); save(); },
    savedJobIds: () => data.saved.map((s) => s.jobId),
    savedJobs: () => data.saved.flatMap((s) => (s.job ? [s.job] : [])),
    setSaved: (jobId, saved, job) => {
      const current = data.saved.find((s) => s.jobId === jobId);
      data.saved = data.saved.filter((s) => s.jobId !== jobId);
      if (saved) data.saved.push({ jobId, job: job ?? current?.job });
      save();
    },
    addRun: (run) => { data.runs.push(run); save(); },
    runStats: () => ({ n: data.runs.length, found: data.runs.reduce((sum, r) => sum + r.found, 0) }),
    addEvent: (stage, message, applicationId) => { data.events.push({ id: data.nextId++, stage, message, createdAt: nowIso(), applicationId }); data.events = data.events.slice(-MAX_EVENTS); save(); },
    recentEvents: (limit) => data.events.slice(-limit).reverse().map(({ id, stage, message, createdAt }) => ({ id, stage, message, createdAt })),
  };

  const core = createCore({
    env: () => ({ JOB_SOURCE: "all", SUBMISSION_MODE: "manual", ...(data.ai.groqKey ? { AI_PROVIDER: "groq", GROQ_API_KEY: data.ai.groqKey, GROQ_MODEL: data.ai.groqModel || DEFAULT_GROQ_MODEL } : {}) }),
    fetchImpl: options.fetchImpl, getJobs: options.getJobs,
  });
  const settings = () => ({ hasGroqKey: Boolean(data.ai.groqKey), groqModel: data.ai.groqModel || DEFAULT_GROQ_MODEL });

  /** Answers one API call. Resolves with the JSON payload (undefined for "no content") or throws HttpError. */
  async function handle(method: string, path: string, body?: unknown): Promise<unknown> {
    load();
    const url = new URL(path, "http://orbit.local");
    const route = `${method.toUpperCase()} ${url.pathname}`;
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const id = url.pathname.split("/")[3];

    if (route === "GET /api/health") return { ...core.health(), database: "browser" };
    if (route === "POST /api/auth/signup") {
      const name = String(b.name ?? "").trim().slice(0, 100);
      if (!name) throw new HttpError(400, "Your name is required");
      if (!data.user) { data.user = { id: 1, email: "", name }; save(); store.addEvent("Requirements", "Workspace created in this browser"); }
      return { token: LOCAL_TOKEN, user: data.user };
    }
    if (route === "GET /api/jobs") return core.searchJobs(data.user ? store : undefined, url.searchParams.get("query"), url.searchParams.get("type"));

    const user = data.user;
    if (!user) throw new HttpError(401, "Authentication required");
    if (route === "GET /api/auth/me") return { user };
    if (route === "POST /api/auth/logout") return undefined;
    if (route === "DELETE /api/account") { storage.removeItem(LOCAL_STORAGE_KEY); data = empty(); return undefined; }
    if (route === "GET /api/settings") return settings();
    if (route === "PUT /api/settings") {
      if (b.groqKey !== undefined) data.ai.groqKey = String(b.groqKey).trim().slice(0, 200);
      if (b.groqModel !== undefined) data.ai.groqModel = String(b.groqModel).trim().slice(0, 100);
      save();
      return settings();
    }
    if (route === "GET /api/profile") return { profile: store.getProfile() };
    if (route === "PUT /api/profile") return { profile: core.saveProfile(store, body) };
    if (route === "GET /api/saved-jobs") return core.savedJobs(store);
    if (url.pathname.startsWith("/api/saved-jobs/") && (method === "PUT" || method === "DELETE")) { core.setSaved(store, id, method === "PUT", b.job); return undefined; }
    if (route === "GET /api/applications") return { applications: store.listApplications() };
    if (route === "POST /api/applications") return (await core.createApplication(store, user, body)).application;
    if (url.pathname.startsWith("/api/applications/") && id) {
      if (url.pathname.endsWith("/submit") && method === "POST") return core.submitApplication(store, id, body);
      if (method === "PATCH") return core.updateApplication(store, id, body);
      if (method === "DELETE") { core.deleteApplication(store, id); return undefined; }
    }
    if (route === "POST /api/tailor") return core.tailor(store, user, body);
    if (route === "POST /api/agent/run") return core.runAgent(store, user, body);
    if (route === "GET /api/reports") return core.report(store, user);
    if (route === "GET /api/reports/export") return core.reportMarkdown(store, user);
    throw new HttpError(404, "Not found");
  }

  return { handle };
}
