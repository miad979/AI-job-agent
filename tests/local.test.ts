import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../shared/core.ts";
import { LOCAL_STORAGE_KEY, createLocalBackend } from "../shared/localBackend.ts";
import type { Job } from "../shared/lib.ts";

// The browser-only build (GitHub Pages) runs this backend over localStorage. Here it runs over a Map.
const RESUME = `Priya Rahman\nData Scientist · 5 years experience\n\nI build machine learning models in Python and PyTorch for medical imaging, with federated learning and NLP research experience.\n\nExperience\n• Trained federated learning models on chest X-ray datasets\n• Built NLP classifiers for Bangla dialect text\n• Wrote reproducible Python evaluation pipelines`;
const mk = (id: number, role: string, skills: string[], description: string): Job => ({ id, company: `Co${id}`, role, type: "Full-time", location: "Remote", salary: "n/a", skills, url: `https://example.com/${id}`, source: "test", description, posted: "today" });
const JOBS = [
  mk(201, "Machine Learning Engineer", ["python", "pytorch", "federated learning"], "Build machine learning models in Python and PyTorch for medical imaging and NLP."),
  mk(202, "Pastry Chef", ["baking", "desserts"], "Prepare croissants, cakes and desserts in a busy bakery kitchen."),
  mk(203, "NLP Research Scientist", ["nlp", "python"], "Research NLP classifiers for low-resource languages using Python."),
];

function setup() {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
  const llmCalls: Array<{ url: string; authorization: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    llmCalls.push({ url: String(input), authorization: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "") });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "LLM summary.", coverLetter: "LLM letter.\nPriya Rahman" }) } }] }), { status: 200 });
  };
  const open = () => createLocalBackend(storage, { fetchImpl, getJobs: async () => JOBS });
  return { map, llmCalls, open, backend: open() };
}
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { if (e instanceof HttpError) return e.status; throw e; } };

describe("browser-only backend", () => {
  test("needs a workspace before anything else, and only asks for a name", async () => {
    const { backend } = setup();
    assert.equal(await status(backend.handle("GET", "/api/profile")), 401);
    assert.equal(await status(backend.handle("GET", "/api/auth/me")), 401);
    assert.equal(await status(backend.handle("POST", "/api/auth/signup", { name: "  " })), 400);
    const created = await backend.handle("POST", "/api/auth/signup", { name: "Priya Rahman" }) as any;
    assert.equal(created.user.name, "Priya Rahman");
    assert.equal((await backend.handle("GET", "/api/auth/me") as any).user.name, "Priya Rahman");
    assert.equal((await backend.handle("GET", "/api/health") as any).database, "browser");
  });

  test("runs the same agent pipeline and approval gate, and survives a reload", async () => {
    const { backend, open, llmCalls } = setup();
    await backend.handle("POST", "/api/auth/signup", { name: "Priya Rahman" });
    assert.equal(await status(backend.handle("POST", "/api/agent/run", { query: "machine learning" })), 400);
    await backend.handle("PUT", "/api/profile", { targetRole: "Machine Learning Engineer", resumeText: RESUME, resumeName: "priya.txt" });

    const jobs = await backend.handle("GET", "/api/jobs?query=machine%20learning&type=All%20types") as any;
    assert.equal(jobs.jobs[0].id, 201);
    const run = await backend.handle("POST", "/api/agent/run", { query: "machine learning", limit: 5, minMatch: 50 }) as any;
    assert.deepEqual(run.queued.map((a: any) => a.jobId).sort(), [201, 203]);
    for (const a of run.queued) { assert.equal(a.status, "Review"); assert.equal(a.generatedBy, "local-template"); assert.match(a.coverLetter, /Priya Rahman$/); }
    assert.equal(llmCalls.length, 0, "no key saved, so nothing may be sent to an LLM");
    assert.equal((await backend.handle("POST", "/api/agent/run", { query: "machine learning", limit: 5, minMatch: 50 }) as any).queued.length, 0);

    // A fresh instance over the same storage is what a page reload looks like.
    const reloaded = open();
    const apps = (await reloaded.handle("GET", "/api/applications") as any).applications;
    assert.equal(apps.length, 2);
    assert.equal((await reloaded.handle("GET", "/api/profile") as any).profile.resumeName, "priya.txt");

    const id = apps[0].id;
    const ask = await reloaded.handle("POST", `/api/applications/${id}/submit`, {}) as any;
    assert.equal(ask.requiresConfirmation, true);
    assert.equal(await status(reloaded.handle("PATCH", `/api/applications/${id}`, { status: "Interview" })), 409);
    const done = await reloaded.handle("POST", `/api/applications/${id}/submit`, { confirmed: true }) as any;
    assert.equal(done.status, "Submitted");
    assert.equal((await reloaded.handle("PATCH", `/api/applications/${id}`, { status: "Offer" }) as any).status, "Offer");

    const report = await reloaded.handle("GET", "/api/reports") as any;
    assert.equal(report.totals.applications, 2);
    assert.equal(report.totals.agentRuns, 2);
    assert.equal(report.totals.submitted, 1);
    assert.equal(report.events[0].stage, "Outcome");
    assert.match(await reloaded.handle("GET", "/api/reports/export") as string, /# Orbit SDLC report/);
  });

  test("saved jobs, edits and removal", async () => {
    const { backend } = setup();
    await backend.handle("POST", "/api/auth/signup", { name: "Priya Rahman" });
    await backend.handle("PUT", "/api/profile", { resumeText: RESUME });
    await backend.handle("PUT", "/api/saved-jobs/203", { job: JOBS[2] });
    assert.deepEqual((await backend.handle("GET", "/api/jobs") as any).saved, [203]);
    assert.equal((await backend.handle("GET", "/api/saved-jobs") as any).jobs[0].role, "NLP Research Scientist");
    await backend.handle("DELETE", "/api/saved-jobs/203");
    assert.deepEqual((await backend.handle("GET", "/api/saved-jobs") as any).jobs, []);

    const app = await backend.handle("POST", "/api/applications", { job: JOBS[0] }) as any;
    const edited = await backend.handle("PATCH", `/api/applications/${app.id}`, { coverLetter: "My own words." }) as any;
    assert.equal(edited.coverLetter, "My own words.");
    await backend.handle("DELETE", `/api/applications/${app.id}`);
    assert.equal((await backend.handle("GET", "/api/applications") as any).applications.length, 0);
    assert.equal(await status(backend.handle("GET", "/api/unknown")), 404);
  });

  test("a saved Groq key switches drafting to the LLM and is never returned", async () => {
    const { backend, llmCalls } = setup();
    await backend.handle("POST", "/api/auth/signup", { name: "Priya Rahman" });
    await backend.handle("PUT", "/api/profile", { resumeText: RESUME });
    assert.equal((await backend.handle("GET", "/api/health") as any).ai, "template");
    const settings = await backend.handle("PUT", "/api/settings", { groqKey: "secret-key" }) as any;
    assert.deepEqual(Object.keys(settings).sort(), ["groqModel", "hasGroqKey"]);
    assert.equal(settings.hasGroqKey, true);
    assert.equal((await backend.handle("GET", "/api/health") as any).ai, "groq");
    const app = await backend.handle("POST", "/api/applications", { job: JOBS[0] }) as any;
    assert.match(app.generatedBy, /^groq:/);
    assert.equal(llmCalls.length, 1);
    assert.match(llmCalls[0].url, /^https:\/\/api\.groq\.com\//);
    assert.equal(llmCalls[0].authorization, "Bearer secret-key");
    assert.equal((await backend.handle("PUT", "/api/settings", { groqKey: "" }) as any).hasGroqKey, false);
  });

  test("erasing the workspace clears the browser storage", async () => {
    const { backend, map } = setup();
    await backend.handle("POST", "/api/auth/signup", { name: "Priya Rahman" });
    await backend.handle("PUT", "/api/profile", { resumeText: RESUME });
    assert.ok(map.get(LOCAL_STORAGE_KEY)?.includes("federated learning"));
    await backend.handle("DELETE", "/api/account");
    assert.equal(map.has(LOCAL_STORAGE_KEY), false);
    assert.equal(await status(backend.handle("GET", "/api/auth/me")), 401);
  });
});
