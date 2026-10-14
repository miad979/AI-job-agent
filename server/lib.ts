export type Job = {
  id: number; company: string; role: string; type: string; location: string; salary: string;
  skills: string[]; url?: string; source: string; description: string; posted: string; match?: number; matchedSkills?: string[];
};
export type Tailoring = { summary: string; coverLetter: string; generatedBy: string };

export const DEMO_JOBS: Job[] = [
  { id: 1, company: "Northstar Labs", role: "Product Designer", type: "Full-time", location: "Remote · US", salary: "$135k–$165k", skills: ["Product strategy", "Figma", "Design systems"], source: "demo", posted: "2h ago", description: "Lead product design across discovery and delivery. Figma, design systems, product strategy, research." },
  { id: 2, company: "Arc & Co.", role: "Senior UX Designer", type: "Contract", location: "New York · Hybrid", salary: "$145k–$180k", skills: ["UX research", "Prototyping", "Facilitation"], source: "demo", posted: "5h ago", description: "Senior UX work: user research, prototyping, workshop facilitation with stakeholders." },
  { id: 3, company: "Lumen Health", role: "Product Design Lead", type: "Internship", location: "Remote · US", salary: "$35–$42/hr", skills: ["Health tech", "Interaction design", "Collaboration"], source: "demo", posted: "1d ago", description: "Interaction design for health technology products. Collaboration with clinicians and engineers." },
];

const STOP = new Set("the and for with that this you your our are will from have has not but can all any who how what when into out about more their they them than then also just such over per via etc job role work team years year experience ability strong working looking join company skills including using use new build building".split(" "));

export const tokenize = (text: string): string[] =>
  text.toLowerCase().replace(/<[^>]+>/g, " ").split(/[^a-z0-9+#.]+/).map((t) => t.replace(/^[.]+|[.]+$/g, "")).filter((t) => t.length > 2 && !STOP.has(t));

export function normalizeType(raw: string | undefined): string {
  const t = (raw ?? "").toLowerCase().replaceAll("_", "-").trim();
  return t === "full-time" ? "Full-time" : t === "part-time" ? "Part-time" : t === "internship" ? "Internship" : t === "contract" ? "Contract" : raw ? raw : "Unspecified";
}

/** Match = how much of the job's vocabulary (title weighted x3, tags x2) appears in the resume. Deterministic & explainable. */
export function scoreJob(resume: string, targetRole: string, job: Job): { match: number; matchedSkills: string[] } {
  const resumeTokens = new Set(tokenize(resume));
  const weights = new Map<string, number>();
  const add = (words: string[], w: number) => words.forEach((x) => weights.set(x, Math.max(weights.get(x) ?? 0, w)));
  add(tokenize(job.description).slice(0, 400), 1);
  add(job.skills.flatMap(tokenize), 2);
  add(tokenize(job.role), 3);
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const hit = [...weights.entries()].filter(([k]) => resumeTokens.has(k));
  const overlap = total ? hit.reduce((a, [, w]) => a + w, 0) / total : 0;
  const roleTokens = tokenize(targetRole);
  const roleHit = roleTokens.length ? roleTokens.filter((t) => tokenize(job.role).includes(t)).length / roleTokens.length : 0;
  const match = Math.max(10, Math.min(99, Math.round(25 + overlap * 140 + roleHit * 25)));
  const matchedSkills = [...new Set([...job.skills, ...tokenize(job.role)].filter((s) => tokenize(s).some((t) => resumeTokens.has(t))))].slice(0, 6);
  return { match, matchedSkills };
}

export function guessName(resume: string, fallback: string): string {
  const first = resume.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return first.length > 1 && first.length <= 50 && !/[@:•|]/.test(first) && first.split(/\s+/).length <= 5 ? first : fallback;
}

export function templateTailoring(resume: string, userName: string, job: Job, matched: string[]): Tailoring {
  const name = guessName(resume, userName);
  const lines = resume.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^[•\-*]/.test(l)).slice(0, 3).map((l) => l.replace(/^[•\-*]\s*/, ""));
  const emphasis = matched.length ? matched.slice(0, 3).join(", ") : "the experience listed in my resume";
  const summary = `Candidate profile for ${job.role} at ${job.company}. Lead with: ${emphasis}.${bullets.length ? " Most relevant stated experience: " + bullets.join("; ") + "." : ""}`;
  const body = bullets.length ? `\n\nHighlights from my background:\n${bullets.map((b) => `• ${b}`).join("\n")}` : "";
  const coverLetter = `Dear ${job.company} hiring team,\n\nI am applying for the ${job.role} position. My background aligns with your needs in ${emphasis}.${body}\n\nI would welcome the chance to discuss how I can contribute.\n\nBest regards,\n${name}`;
  return { summary, coverLetter, generatedBy: "local-template" };
}

const SYSTEM = "You tailor job applications truthfully. Use ONLY facts present in the resume. Never invent skills, employers, dates, credentials, metrics or experience. Respond with a single JSON object: {\"summary\": string, \"coverLetter\": string}. coverLetter must be plain text under 250 words and end with the candidate's name.";

export function parseTailoringJson(raw: string): { summary: string; coverLetter: string } | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { summary?: unknown; coverLetter?: unknown };
    if (typeof parsed.summary === "string" && typeof parsed.coverLetter === "string" && parsed.summary.trim() && parsed.coverLetter.trim()) return { summary: parsed.summary.trim(), coverLetter: parsed.coverLetter.trim() };
  } catch { /* fall through */ }
  return null;
}

export async function llmTailoring(resume: string, userName: string, job: Job, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<Tailoring | null> {
  const prompt = `Candidate name: ${guessName(resume, userName)}\nJob: ${job.role} at ${job.company}\nJob description: ${job.description.replace(/<[^>]+>/g, " ").slice(0, 2500)}\n\nResume:\n${resume.slice(0, 6000)}`;
  const timeout = AbortSignal.timeout(45000);
  try {
    if (env.AI_PROVIDER === "groq" && env.GROQ_API_KEY) {
      const model = env.GROQ_MODEL || "openai/gpt-oss-20b";
      const res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", { method: "POST", signal: timeout, headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` }, body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }] }) });
      if (!res.ok) return null;
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const parsed = parseTailoringJson(data.choices?.[0]?.message?.content ?? "");
      return parsed ? { ...parsed, generatedBy: `groq:${model}` } : null;
    }
    if (env.AI_PROVIDER === "ollama" && env.OLLAMA_MODEL) {
      const res = await fetchImpl(`${env.OLLAMA_URL || "http://127.0.0.1:11434"}/api/chat`, { method: "POST", signal: timeout, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: env.OLLAMA_MODEL, stream: false, format: "json", messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }] }) });
      if (!res.ok) return null;
      const data = await res.json() as { message?: { content?: string } };
      const parsed = parseTailoringJson(data.message?.content ?? "");
      return parsed ? { ...parsed, generatedBy: `ollama:${env.OLLAMA_MODEL}` } : null;
    }
  } catch (error) { console.warn("LLM tailoring failed, using template:", error instanceof Error ? error.message : error); }
  return null;
}

type RemotiveJob = { id: number; title: string; company_name: string; job_type?: string; candidate_required_location?: string; salary?: string; url: string; description?: string; tags?: string[]; publication_date?: string };
const cache = new Map<string, { at: number; jobs: Job[] }>();

export async function fetchRemotive(query: string, fetchImpl: typeof fetch = fetch): Promise<Job[]> {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.jobs;
  const params = new URLSearchParams({ limit: "60" });
  if (query) params.set("search", query);
  const res = await fetchImpl(`https://remotive.com/api/remote-jobs?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Remotive returned ${res.status}`);
  const payload = await res.json() as { jobs?: RemotiveJob[] };
  const jobs = (payload.jobs ?? []).map((j): Job => ({
    id: 100000 + j.id, company: j.company_name, role: j.title, type: normalizeType(j.job_type), location: j.candidate_required_location || "Remote",
    salary: j.salary || "Salary not listed", skills: (j.tags ?? []).slice(0, 6), url: j.url, source: "Remotive",
    description: (j.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 3000),
    posted: j.publication_date ? j.publication_date.slice(0, 10) : "recent",
  }));
  cache.set(query, { at: Date.now(), jobs });
  return jobs;
}
