import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, openDb } from "../server/app.ts";
import { parseTailoringJson, scoreJob, templateTailoring, tokenize } from "../server/lib.ts";
import type { Job } from "../server/lib.ts";

const RESUME = `Priya Rahman\nData Scientist · 5 years experience\n\nI build machine learning models in Python and PyTorch for medical imaging, with federated learning and NLP research experience.\n\nExperience\n• Trained federated learning models on chest X-ray datasets\n• Built NLP classifiers for Bangla dialect text\n• Wrote reproducible Python evaluation pipelines`;
const mk = (id: number, role: string, skills: string[], description: string, url = `https://example.com/${id}`): Job => ({ id, company: `Co${id}`, role, type: "Full-time", location: "Remote", salary: "n/a", skills, url, source: "test", description, posted: "today" });
const JOBS = [
  mk(201, "Machine Learning Engineer", ["python", "pytorch", "federated learning"], "Build machine learning models in Python and PyTorch for medical imaging and NLP."),
  mk(202, "Pastry Chef", ["baking", "desserts"], "Prepare croissants, cakes and desserts in a busy bakery kitchen."),
  mk(203, "NLP Research Scientist", ["nlp", "python"], "Research NLP classifiers for low-resource languages using Python."),
  mk(204, "Accountant", ["excel", "tax"], "Handle bookkeeping, tax filings and Excel reports."),
];

let server: Server; let base: string; let groqMode: "good" | "bad" = "good";
const fakeFetch: typeof fetch = async (input) => {
  if (String(input).includes("api.groq.com")) {
    const content = groqMode === "good" ? JSON.stringify({ summary: "LLM summary from resume facts.", coverLetter: "Dear team,\nLLM letter.\nPriya Rahman" }) : "sorry, no json here";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }
  throw new Error(`unexpected network call: ${String(input)}`);
};

before(async () => {
  const app = createApp({ db: openDb(":memory:"), env: { AI_PROVIDER: "groq", GROQ_API_KEY: "test-key", GROQ_MODEL: "test-model" }, fetchImpl: fakeFetch, getJobs: async (q) => JOBS.filter((j) => !q || `${j.role} ${j.description}`.toLowerCase().split(/\s+/).some((w) => q.toLowerCase().includes(w) && w.length > 3) || true) });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};
const signup = async (email: string, name = "Test User") => (await call("POST", "/api/auth/signup", { email, name, password: "correct-horse-1" })).json as { token: string; user: { id: number } };

describe("auth", () => {
  test("signup validates input and rejects duplicates", async () => {
    assert.equal((await call("POST", "/api/auth/signup", { email: "bad", name: "x", password: "short" })).status, 400);
    const a = await call("POST", "/api/auth/signup", { email: "Dup@Example.com", name: "Dup", password: "correct-horse-1" });
    assert.equal(a.status, 201);
    assert.ok(a.json.token.length >= 32);
    assert.equal((await call("POST", "/api/auth/signup", { email: "dup@example.com", name: "Dup", password: "correct-horse-1" })).status, 409);
  });
  test("login, me, logout lifecycle", async () => {
    await signup("life@example.com");
    assert.equal((await call("POST", "/api/auth/login", { email: "life@example.com", password: "wrong-password" })).status, 401);
    const ok = await call("POST", "/api/auth/login", { email: "LIFE@example.com", password: "correct-horse-1" });
    assert.equal(ok.status, 200);
    const me = await call("GET", "/api/auth/me", undefined, ok.json.token);
    assert.equal(me.json.user.email, "life@example.com");
    await call("POST", "/api/auth/logout", undefined, ok.json.token);
    assert.equal((await call("GET", "/api/auth/me", undefined, ok.json.token)).status, 401);
  });
  test("protected routes require a token", async () => {
    for (const p of ["/api/applications", "/api/reports", "/api/profile"]) assert.equal((await call("GET", p)).status, 401, p);
    assert.equal((await call("POST", "/api/agent/run", {})).status, 401);
  });
});

describe("agent pipeline", () => {
  let token = ""; let appIds: number[] = [];
  before(async () => { token = (await signup("agent@example.com", "Priya Rahman")).token; });

  test("agent refuses to run without a resume", async () => {
    const r = await call("POST", "/api/agent/run", { query: "machine learning" }, token);
    assert.equal(r.status, 400);
  });
  test("profile persists", async () => {
    const put = await call("PUT", "/api/profile", { targetRole: "Machine Learning Engineer", jobType: "All types", resumeText: RESUME, resumeName: "priya.txt" }, token);
    assert.equal(put.status, 200);
    const got = await call("GET", "/api/profile", undefined, token);
    assert.equal(got.json.profile.targetRole, "Machine Learning Engineer");
    assert.equal(got.json.profile.resumeName, "priya.txt");
  });
  test("jobs are ranked against the user's resume", async () => {
    const r = await call("GET", "/api/jobs?query=&type=All%20types", undefined, token);
    const order = (r.json.jobs as Job[]).map((j) => j.id);
    assert.ok(order.indexOf(201) < order.indexOf(202));
    assert.ok(order.indexOf(203) < order.indexOf(204));
    assert.equal(order[order.length - 1] === 202 || order[order.length - 1] === 204, true);
  });
  test("agent run discovers, tailors with the LLM, and queues for review only", async () => {
    const r = await call("POST", "/api/agent/run", { query: "machine learning", limit: 2, minMatch: 50 }, token);
    assert.equal(r.status, 200);
    assert.equal(r.json.queued.length, 2);
    const ids = r.json.queued.map((a: any) => a.jobId).sort();
    assert.deepEqual(ids, [201, 203]);
    for (const a of r.json.queued) { assert.equal(a.status, "Review"); assert.equal(a.generatedBy, "groq:test-model"); assert.match(a.coverLetter, /LLM letter/); }
    appIds = r.json.queued.map((a: any) => a.id);
  });
  test("a second run does not duplicate applications", async () => {
    const r = await call("POST", "/api/agent/run", { query: "machine learning", limit: 5, minMatch: 50 }, token);
    assert.equal(r.json.queued.filter((a: any) => [201, 203].includes(a.jobId)).length, 0);
    const list = await call("GET", "/api/applications", undefined, token);
    assert.equal(new Set(list.json.applications.map((a: any) => a.jobId)).size, list.json.applications.length);
  });
  test("falls back to the truthful template when the LLM returns garbage", async () => {
    groqMode = "bad";
    try {
      const add = await call("POST", "/api/applications", { job: JOBS[3] }, token);
      assert.equal(add.status, 201);
      assert.equal(add.json.generatedBy, "local-template");
      assert.match(add.json.coverLetter, /Priya Rahman/);
    } finally { groqMode = "good"; }
  });
  test("submission needs explicit confirmation and cannot skip review", async () => {
    const id = appIds[0];
    const ask = await call("POST", `/api/applications/${id}/submit`, {}, token);
    assert.equal(ask.json.requiresConfirmation, true);
    assert.ok(ask.json.applyUrl);
    assert.equal((await call("GET", "/api/applications", undefined, token)).json.applications.find((a: any) => a.id === id).status, "Review");
    assert.equal((await call("PATCH", `/api/applications/${id}`, { status: "Interview" }, token)).status, 409);
    const done = await call("POST", `/api/applications/${id}/submit`, { confirmed: true }, token);
    assert.equal(done.json.status, "Submitted");
    assert.ok(done.json.submittedAt);
    assert.equal((await call("PATCH", `/api/applications/${id}`, { status: "Interview" }, token)).json.status, "Interview");
    assert.equal((await call("PATCH", `/api/applications/${id}`, { status: "Bogus" }, token)).status, 400);
  });
  test("users cannot see or modify each other's data", async () => {
    const other = (await signup("other@example.com")).token;
    assert.equal((await call("GET", "/api/applications", undefined, other)).json.applications.length, 0);
    assert.equal((await call("PATCH", `/api/applications/${appIds[1]}`, { status: "Rejected" }, other)).status, 404);
    assert.equal((await call("POST", `/api/applications/${appIds[1]}/submit`, { confirmed: true }, other)).status, 404);
    assert.equal((await call("GET", "/api/reports", undefined, other)).json.totals.applications, 0);
  });
  test("saved jobs round-trip", async () => {
    await call("PUT", "/api/saved-jobs/202", undefined, token);
    assert.deepEqual((await call("GET", "/api/jobs", undefined, token)).json.saved, [202]);
    await call("DELETE", "/api/saved-jobs/202", undefined, token);
    assert.deepEqual((await call("GET", "/api/jobs", undefined, token)).json.saved, []);
  });
  test("SDLC report reflects real pipeline state and exports", async () => {
    const r = (await call("GET", "/api/reports", undefined, token)).json;
    assert.equal(r.totals.applications, 3);
    assert.equal(r.totals.agentRuns, 2);
    assert.equal(r.totals.submitted, 1);
    assert.equal(r.totals.review, 2);
    assert.deepEqual(r.stages.map((s: any) => s.name), ["Requirements", "Discovery", "Tailoring", "Review", "Submission", "Outcome"]);
    assert.equal(r.stages.find((s: any) => s.name === "Outcome").status, "complete");
    assert.ok(r.events.length >= 6);
    const md = await call("GET", "/api/reports/export", undefined, token);
    assert.match(md.text, /# Orbit SDLC report/);
    assert.match(md.text, /Submission/);
  });
});

describe("matching & tailoring helpers", () => {
  test("scoreJob prefers relevant jobs", () => {
    const good = scoreJob(RESUME, "Machine Learning Engineer", JOBS[0]).match;
    const bad = scoreJob(RESUME, "Machine Learning Engineer", JOBS[1]).match;
    assert.ok(good > bad + 20, `${good} vs ${bad}`);
  });
  test("tokenize drops stopwords and html", () => assert.deepEqual(tokenize("<b>Python</b> and the PyTorch team"), ["python", "pytorch"]));
  test("template tailoring only uses facts from the resume", () => {
    const t = templateTailoring(RESUME, "Fallback", JOBS[0], ["python"]);
    assert.match(t.coverLetter, /Priya Rahman$/);
    assert.match(t.coverLetter, /federated learning models on chest X-ray/);
    assert.doesNotMatch(t.coverLetter, /Alex Morgan|7 years/);
  });
  test("parseTailoringJson tolerates fences and rejects junk", () => {
    assert.deepEqual(parseTailoringJson("```json\n{\"summary\":\"a\",\"coverLetter\":\"b\"}\n```"), { summary: "a", coverLetter: "b" });
    assert.equal(parseTailoringJson("nope"), null);
    assert.equal(parseTailoringJson("{\"summary\":\"\",\"coverLetter\":\"b\"}"), null);
  });
});
