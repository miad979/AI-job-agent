import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../shared/core.ts";
import { createLocalBackend } from "../shared/localBackend.ts";
import { clearJobCache, fetchJobicy, locationFits, matchesQuery, plainText } from "../shared/lib.ts";
import type { Job } from "../shared/lib.ts";

const REMOTIVE = { jobs: [
  { id: 1, title: "Python Developer", company_name: "Acme", job_type: "full_time", candidate_required_location: "Worldwide", url: "https://remotive.com/jobs/1", description: "<p>Build APIs in <b>Python</b> &amp; Django.</p>", tags: ["python", "django"], publication_date: "2026-11-01T10:00:00" },
  { id: 2, title: "Pastry Chef", company_name: "Bakehouse", job_type: "contract", candidate_required_location: "France", url: "https://remotive.com/jobs/2", description: "<p>Croissants and cakes.</p>", tags: ["baking"] },
] };
const JOBICY = { jobs: [
  { id: 10, url: "https://jobicy.com/jobs/10", jobTitle: "Data Engineer &#8211; Platform", companyName: "Globex", jobIndustry: ["Data Science &amp; Analytics"], jobType: ["Full-Time"], jobGeo: "Canada,  USA", jobLevel: "Senior", jobDescription: "<h3>Role</h3><p>Pipelines in Python and SQL.</p>", pubDate: "2026-11-10T09:00:00+00:00", salaryMin: 120000, salaryMax: 150000, salaryCurrency: "USD", salaryPeriod: "yearly" },
  { id: 11, url: "https://jobicy.com/jobs/11", jobTitle: "Python Developer", companyName: "Acme", jobType: ["Contract"], jobGeo: "Anywhere", jobLevel: "Any", jobExcerpt: "Same opening as on Remotive, Python.", pubDate: "2026-11-09T09:00:00+00:00" },
  { id: 12, url: "https://jobicy.com/jobs/12", jobTitle: "Growth Marketer", companyName: "Initech", jobType: ["Internship"], jobGeo: "UK", jobDescription: "<p>Campaigns and newsletters.</p>" },
] };

/** A fetch that serves the two feeds from fixtures and records what was asked. */
function feeds(down: string[] = []) {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input); urls.push(url);
    const name = url.includes("remotive.com") ? "remotive" : url.includes("jobicy.com") ? "jobicy" : "";
    if (!name) throw new Error(`unexpected network call: ${url}`);
    if (down.includes(name)) return new Response("nope", { status: 503 });
    return new Response(JSON.stringify(name === "remotive" ? REMOTIVE : JOBICY), { status: 200 });
  };
  return { urls, fetchImpl };
}

beforeEach(() => clearJobCache());

describe("live job sources", () => {
  test("listing HTML becomes plain text", () => {
    assert.equal(plainText("<p>R&amp;D &#8211; caf&#xe9;&nbsp;team</p>\n<br>  ok"), "R&D – café team ok");
    assert.equal(plainText(undefined), "");
  });

  test("Jobicy listings are mapped to Orbit jobs and searched by tag", async () => {
    const { urls, fetchImpl } = feeds();
    const jobs = await fetchJobicy(" Machine Learning ", fetchImpl);
    assert.equal(new URL(urls[0]).searchParams.get("tag"), "machine learning");
    assert.deepEqual(jobs[0], { id: 500_000_010, company: "Globex", role: "Data Engineer – Platform", type: "Full-time", location: "Canada, USA", salary: "USD 120,000–150,000 / yearly", skills: ["Data Science & Analytics", "Senior"], url: "https://jobicy.com/jobs/10", source: "Jobicy", description: "Role Pipelines in Python and SQL.", posted: "2026-11-10" });
    assert.equal(jobs[1].salary, "Salary not listed");
    assert.equal(jobs[2].type, "Internship");
    await fetchJobicy("machine learning", fetchImpl);
    assert.equal(urls.length, 1, "a repeated search is served from the cache");
  });

  test("a search needs every word to appear in the listing", () => {
    const job: Job = { id: 1, company: "Acme", role: "Senior Product Designer", type: "Full-time", location: "USA", salary: "", skills: ["Figma"], source: "test", description: "Design systems and research.", posted: "" };
    assert.equal(matchesQuery(job, ""), true);
    assert.equal(matchesQuery(job, "product design"), true);
    assert.equal(matchesQuery(job, "FIGMA acme"), true);
    assert.equal(matchesQuery(job, "product python"), false);
  });

  test("feeds are merged, searched locally, de-duplicated and credited", async () => {
    const { urls, fetchImpl } = feeds();
    const core = createCore({ env: () => ({}), fetchImpl });
    const all = await core.searchJobs(undefined, "", "");
    assert.equal(all.source, "Remotive + Jobicy");
    assert.equal(all.jobs.length, 4, "the opening listed on both feeds appears once");
    assert.ok(!urls.find((u) => u.includes("remotive.com"))?.includes("search"), "Remotive ignores search, so none is sent");

    const python = await core.searchJobs(undefined, "python", "");
    assert.deepEqual(python.jobs.map((j) => `${j.source}:${j.role}`).sort(), ["Jobicy:Data Engineer – Platform", "Remotive:Python Developer"]);
    assert.equal((await core.searchJobs(undefined, "", "Internship")).jobs[0].role, "Growth Marketer");
    assert.deepEqual((await core.searchJobs(undefined, "zzz-nothing", "")).jobs, []);
  });

  test("one feed down still works; all down falls back to the demo jobs", async () => {
    const one = createCore({ env: () => ({}), fetchImpl: feeds(["remotive"]).fetchImpl });
    const partial = await one.searchJobs(undefined, "", "");
    assert.equal(partial.source, "Jobicy");
    assert.equal(partial.jobs.length, 3);

    clearJobCache();
    const none = createCore({ env: () => ({}), fetchImpl: feeds(["remotive", "jobicy"]).fetchImpl });
    assert.equal((await none.searchJobs(undefined, "", "")).source, "demo");
  });

  test("JOB_SOURCE picks the feeds", async () => {
    const only = feeds();
    assert.equal((await createCore({ env: () => ({ JOB_SOURCE: "jobicy" }), fetchImpl: only.fetchImpl }).searchJobs(undefined, "", "")).source, "Jobicy");
    assert.ok(only.urls.every((u) => u.includes("jobicy.com")));
    const demo = feeds();
    assert.equal((await createCore({ env: () => ({ JOB_SOURCE: "demo" }), fetchImpl: demo.fetchImpl }).searchJobs(undefined, "", "")).source, "demo");
    assert.equal(demo.urls.length, 0, "demo mode never touches the network");
  });
});

describe("location preference", () => {
  test("locationFits", () => {
    assert.equal(locationFits("USA", ""), undefined);
    assert.equal(locationFits("USA", "Remote"), undefined, "\"Remote\" names no place");
    assert.equal(locationFits("Worldwide", "Germany"), true);
    assert.equal(locationFits("Remote", "Germany"), true);
    assert.equal(locationFits("Canada, USA", "United States"), true);
    assert.equal(locationFits("Canada, USA", "remote, US"), true);
    assert.equal(locationFits("UK", "London, United Kingdom"), true);
    assert.equal(locationFits("Europe", "USA"), false);
    assert.equal(locationFits("New Zealand", "New York"), false);
    assert.equal(locationFits("Bangladesh, India", "Dhaka, Bangladesh"), true);
  });

  test("listings are flagged and the agent drafts location-compatible ones first", async () => {
    const RESUME = "Priya Rahman\nData Scientist\n\nI build machine learning models in Python and PyTorch for medical imaging with NLP research experience.\n\n• Trained federated learning models\n• Built NLP classifiers in Python";
    const mk = (id: number, location: string): Job => ({ id, company: `Co${id}`, role: "Machine Learning Engineer", type: "Full-time", location, salary: "n/a", skills: ["python", "pytorch"], url: `https://example.com/${id}`, source: "test", description: id === 1 ? "Machine learning models in Python and PyTorch for medical imaging and NLP research." : "Machine learning models in Python.", posted: "today" });
    const map = new Map<string, string>();
    const backend = createLocalBackend({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } }, { getJobs: async () => [mk(1, "USA"), mk(2, "Germany"), mk(3, "Worldwide")] });
    await backend.handle("POST", "/api/auth/signup", { name: "Priya Rahman" });
    await backend.handle("PUT", "/api/profile", { targetRole: "Machine Learning Engineer", location: "Berlin, Germany", resumeText: RESUME });

    const listed = (await backend.handle("GET", "/api/jobs") as { jobs: Job[] }).jobs;
    assert.equal(listed[0].id, 1, "ranking by resume match is unchanged");
    assert.deepEqual(Object.fromEntries(listed.map((j) => [j.id, j.locationFit])), { 1: false, 2: true, 3: true });

    const run = await backend.handle("POST", "/api/agent/run", { limit: 2, minMatch: 40 }) as { queued: Array<{ jobId: number; job: Job }> };
    assert.deepEqual(run.queued.map((a) => a.jobId).sort(), [2, 3]);
    assert.equal("locationFit" in run.queued[0].job, false, "the stored listing keeps only listing facts");

    await backend.handle("PUT", "/api/profile", { location: "" });
    assert.equal((await backend.handle("GET", "/api/jobs") as { jobs: Job[] }).jobs.some((j) => "locationFit" in j), false);
  });
});
