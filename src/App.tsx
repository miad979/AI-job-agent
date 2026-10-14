import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import "./App.css";

type Job = { id: number; company: string; role: string; type: string; location: string; salary: string; skills: string[]; url?: string; source: string; description: string; posted: string; match?: number; matchedSkills?: string[] };
type Status = "Review" | "Submitted" | "Interview" | "Offer" | "Rejected";
type Application = { id: number; jobId: number; job: Job; status: Status; match: number; summary: string; coverLetter: string; generatedBy: string; createdAt: string; updatedAt: string; submittedAt: string | null };
type User = { id: number; email: string; name: string };
type Profile = { targetRole: string; jobType: string; location: string; resumeText: string; resumeName: string };
type Report = { generatedAt: string; stages: Array<{ name: string; status: string; count: number; detail: string }>; totals: Record<string, number>; bySource: Record<string, number>; byAi: Record<string, number>; events: Array<{ id: number; stage: string; message: string; createdAt: string }> };
type AgentResult = { query: string; source: string; found: number; minMatch: number; queued: Application[]; skipped: number; belowThreshold: number };

const TOKEN_KEY = "orbit-token";
const EMPTY_PROFILE: Profile = { targetRole: "", jobType: "All types", location: "", resumeText: "", resumeName: "" };
const JOB_TYPES = ["All types", "Full-time", "Internship", "Contract", "Part-time"];
const COLORS = ["coral", "blue", "yellow"];
const initials = (job: Job) => job.company.slice(0, 1).toUpperCase();
const color = (job: Job) => COLORS[job.id % 3];
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return pages.join("\n\n");
}
async function extractDocxText(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
}
function downloadText(filename: string, text: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [nav, setNav] = useState("Overview");
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [jobType, setJobType] = useState("All types");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobSource, setJobSource] = useState("loading");
  const [jobLoading, setJobLoading] = useState(false);
  const [jobError, setJobError] = useState("");
  const [saved, setSaved] = useState<number[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [focusJob, setFocusJob] = useState<Job | null>(null);
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<number | undefined>(undefined);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 3600);
  }, []);
  const logout = useCallback(() => { localStorage.removeItem(TOKEN_KEY); setToken(""); setUser(null); setProfile(EMPTY_PROFILE); setProfileLoaded(false); setApplications([]); setAgentResult(null); }, []);
  const api = useCallback(async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const res = await fetch(path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 204) return undefined as T;
    const payload = await res.json().catch(() => ({})) as T & { error?: string };
    if (res.status === 401 && token) logout();
    if (!res.ok) throw new Error(payload.error ?? `Request failed (${res.status})`);
    return payload;
  }, [token, logout]);

  // Restore session
  useEffect(() => {
    if (!token) { setReady(true); return; }
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("expired"))))
      .then((p: { user: User }) => setUser(p.user))
      .catch(() => { localStorage.removeItem(TOKEN_KEY); setToken(""); })
      .finally(() => setReady(true));
  }, [token]);

  // Load profile + applications once signed in
  useEffect(() => {
    if (!user) return;
    api<{ profile: Profile }>("/api/profile").then((p) => { setProfile(p.profile); setSearchTerm(p.profile.targetRole); setSearchQuery(p.profile.targetRole); if (p.profile.jobType) setJobType(p.profile.jobType); setProfileLoaded(true); }).catch(() => setProfileLoaded(true));
    api<{ applications: Application[] }>("/api/applications").then((p) => setApplications(p.applications)).catch(() => undefined);
  }, [user, api]);

  // Search jobs (server scores them against the saved resume)
  const loadJobs = useCallback(() => {
    if (!user) return;
    setJobLoading(true); setJobError("");
    api<{ jobs: Job[]; source: string; saved: number[] }>(`/api/jobs?${new URLSearchParams({ query: searchQuery, type: jobType })}`)
      .then((p) => { setJobs(p.jobs); setJobSource(p.source); setSaved(p.saved); })
      .catch((e: unknown) => { setJobs([]); setJobSource("unavailable"); setJobError(e instanceof Error ? e.message : "Job search failed"); })
      .finally(() => setJobLoading(false));
  }, [user, api, searchQuery, jobType]);
  useEffect(() => { if (profileLoaded) loadJobs(); }, [profileLoaded, loadJobs]);

  // Persist resume edits (debounced)
  const saveTimer = useRef<number | undefined>(undefined);
  const updateResume = (resumeText: string, resumeName?: string) => {
    setProfile((p) => ({ ...p, resumeText, resumeName: resumeName ?? p.resumeName }));
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { api("/api/profile", "PUT", { resumeText, ...(resumeName ? { resumeName } : {}) }).catch(() => showNotice("Could not save your resume. Is the API running?")); }, 700);
  };
  const saveProfile = async (next: Partial<Profile>) => {
    const merged = { ...profile, ...next };
    setProfile(merged);
    try { await api("/api/profile", "PUT", merged); showNotice("Profile saved."); } catch (e) { showNotice(e instanceof Error ? e.message : "Could not save profile"); }
  };

  const replaceApp = (updated: Application) => setApplications((cur) => (cur.some((a) => a.id === updated.id) ? cur.map((a) => (a.id === updated.id ? updated : a)) : [updated, ...cur]));
  const toggleSave = async (id: number) => {
    const on = saved.includes(id);
    setSaved((cur) => (on ? cur.filter((x) => x !== id) : [...cur, id]));
    try { await api(`/api/saved-jobs/${id}`, on ? "DELETE" : "PUT"); } catch { setSaved((cur) => (on ? [...cur, id] : cur.filter((x) => x !== id))); }
  };
  const queueJob = async (job: Job) => {
    try {
      const { match: _m, matchedSkills: _s, ...clean } = job; void _m; void _s;
      const app = await api<Application>("/api/applications", "POST", { job: clean });
      replaceApp(app); setFocusJob(app.job); setNav("Resume studio"); showNotice("Draft created. Review it before anything is sent.");
    } catch (e) { showNotice(e instanceof Error ? e.message : "Could not queue job"); }
  };
  const submitApplication = async (app: Application) => {
    try {
      const first = await api<Application & { requiresConfirmation?: boolean; applyUrl?: string | null; application?: Application }>(`/api/applications/${app.id}/submit`, "POST", {});
      if (first.requiresConfirmation) {
        if (first.applyUrl) window.open(first.applyUrl, "_blank", "noopener");
        if (!window.confirm(`Orbit opened the listing for ${app.job.role} at ${app.job.company}. Submit it there with your reviewed materials.\n\nClick OK once you have applied so Orbit can mark it Submitted.`)) { showNotice("Left in review. Nothing was marked submitted."); return; }
        replaceApp(await api<Application>(`/api/applications/${app.id}/submit`, "POST", { confirmed: true }));
      } else replaceApp(first);
      showNotice("Marked as submitted.");
    } catch (e) { showNotice(e instanceof Error ? e.message : "Submit failed"); }
  };
  const setStatus = async (app: Application, status: Status) => { try { replaceApp(await api<Application>(`/api/applications/${app.id}`, "PATCH", { status })); } catch (e) { showNotice(e instanceof Error ? e.message : "Update failed"); } };
  const removeApp = async (app: Application) => { if (!window.confirm(`Remove ${app.job.role} at ${app.job.company}?`)) return; await api(`/api/applications/${app.id}`, "DELETE"); setApplications((cur) => cur.filter((a) => a.id !== app.id)); };
  const runAgent = async (opts: { query: string; limit: number; minMatch: number }) => {
    setAgentBusy(true);
    try {
      const result = await api<AgentResult>("/api/agent/run", "POST", { ...opts, type: jobType });
      setAgentResult(result); setApplications((cur) => [...result.queued, ...cur]);
      showNotice(result.queued.length ? `Agent drafted ${result.queued.length} application${result.queued.length === 1 ? "" : "s"} for your review.` : "Agent found nothing new above your match threshold.");
      loadJobs();
    } catch (e) { showNotice(e instanceof Error ? e.message : "Agent run failed"); }
    finally { setAgentBusy(false); }
  };
  const handleResumeFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    try {
      const text = file.name.toLowerCase().endsWith(".pdf") ? await extractPdfText(file) : file.name.toLowerCase().endsWith(".docx") ? await extractDocxText(file) : await file.text();
      if (!text.trim()) throw new Error("empty");
      updateResume(text, file.name); showNotice("Resume imported and saved.");
    } catch { showNotice("This file could not be read. You can paste its text instead."); }
  };

  if (!ready) return <div className="auth-loading">Loading your workspace...</div>;
  if (!user) return <AuthScreen onAuthenticated={(t, u) => { localStorage.setItem(TOKEN_KEY, t); setToken(t); setUser(u); }} />;

  const reviewCount = applications.filter((a) => a.status === "Review").length;
  const submittedCount = applications.length - reviewCount;
  const resumeWords = profile.resumeText.split(/\s+/).filter(Boolean).length;
  const profileScore = Math.min(100, (profile.targetRole ? 25 : 0) + Math.min(50, Math.round(resumeWords / 6)) + (profile.location ? 10 : 0) + (profile.jobType ? 5 : 0) + (applications.length ? 10 : 0));
  const first = user.name.split(" ")[0];
  const navIcons: Record<string, string> = { Overview: "◈", "Job matches": "⌕", Applications: "▣", "Resume studio": "✎", Reports: "▤" };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">✦</span><span>orbit<span className="brand-dot">.</span></span></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="nav-list" aria-label="Main navigation">
          {Object.keys(navIcons).map((item) => (
            <button className={nav === item ? "nav-item active" : "nav-item"} onClick={() => setNav(item)} key={item}>
              <span className="nav-icon" aria-hidden="true">{navIcons[item]}</span>{item}
              {item === "Applications" && <span className="nav-count">{applications.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-label">YOUR PROFILE</div>
          <button className="profile-mini" onClick={() => setShowProfile(true)}>
            <span className="avatar">{user.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}</span>
            <span><strong>{user.name}</strong><small>{profile.targetRole || "Set a target role"}</small></span>
            <span className="more">···</span>
          </button>
          <button className="logout-button" onClick={() => { api("/api/auth/logout", "POST").catch(() => undefined); logout(); }}>Log out</button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> {nav}</div>
          <div className="top-actions"><button className="help-button" onClick={() => showNotice("Orbit never marks anything submitted without your confirmation.")}>?</button></div>
        </header>
        {nav === "Reports" ? <Reports api={api} onNotice={showNotice} />
          : nav === "Resume studio" ? <ResumeStudio profile={profile} user={user} jobs={jobs} applications={applications} focusJob={focusJob} onFocus={setFocusJob} onResume={updateResume} onFile={handleResumeFile} onQueue={queueJob} onSaved={replaceApp} api={api} onNotice={showNotice} />
          : nav === "Applications" ? <Applications applications={applications} onReview={(a) => { setFocusJob(a.job); setNav("Resume studio"); }} onSubmit={submitApplication} onStatus={setStatus} onRemove={removeApp} />
          : <Dashboard first={first} nav={nav} jobType={jobType} setJobType={setJobType} searchTerm={searchTerm} setSearchTerm={setSearchTerm} onSearch={() => setSearchQuery(searchTerm)} jobs={jobs} jobSource={jobSource} jobLoading={jobLoading} jobError={jobError} profileScore={profileScore} saved={saved} onSave={toggleSave} onQueue={queueJob} applications={applications} reviewCount={reviewCount} submittedCount={submittedCount} onProfile={() => setShowProfile(true)} onNav={setNav} hasResume={resumeWords >= 20} agentBusy={agentBusy} agentResult={agentResult} onRun={runAgent} defaultQuery={profile.targetRole} />}
      </main>
      {showProfile && <ProfileModal profile={profile} name={user.name} onClose={() => setShowProfile(false)} onSave={async (next) => { await saveProfile(next); setSearchTerm(next.targetRole); setSearchQuery(next.targetRole); setJobType(next.jobType); setShowProfile(false); }} />}
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const res = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password }) });
      const payload = await res.json().catch(() => ({})) as { token?: string; user?: User; error?: string };
      if (!res.ok || !payload.token || !payload.user) throw new Error(payload.error ?? "Authentication failed");
      onAuthenticated(payload.token, payload.user);
    } catch (e) { setError(e instanceof TypeError ? "Cannot reach the Orbit API. Run `npm run dev:full`." : e instanceof Error ? e.message : "Authentication failed"); }
    finally { setBusy(false); }
  };
  return (
    <main className="auth-shell"><div className="auth-card">
      <div className="brand auth-brand"><span className="brand-mark">✦</span><span>orbit<span className="brand-dot">.</span></span></div>
      <p className="eyebrow">PRIVATE JOB WORKSPACE</p>
      <h1>{mode === "login" ? "Welcome back." : "Create your workspace."}</h1>
      <p className="subhead">Your resume, drafts and applications are stored in your own Orbit database.</p>
      <form onSubmit={submit}>
        {mode === "signup" && <label>Full name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></label>}
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} required /></label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="primary-button full" disabled={busy}>{busy ? "Working..." : mode === "login" ? "Log in" : "Sign up"}<span>→</span></button>
      </form>
      <button className="auth-switch" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}>{mode === "login" ? "Create a new account" : "Already have an account? Log in"}</button>
    </div></main>
  );
}

function ProfileModal({ profile, name, onClose, onSave }: { profile: Profile; name: string; onClose: () => void; onSave: (p: Pick<Profile, "targetRole" | "jobType" | "location">) => void }) {
  const [targetRole, setTargetRole] = useState(profile.targetRole); const [jobType, setJobType] = useState(profile.jobType || "All types"); const [location, setLocation] = useState(profile.location);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
        <button className="close-button" onClick={onClose} aria-label="Close">×</button>
        <p className="eyebrow">YOUR PROFILE</p><h2>{name}</h2>
        <div className="truth-box"><span>✓</span><div><strong>Truth-first profile</strong><p>Orbit reframes real experience, but never invents skills, employers, dates, or credentials.</p></div></div>
        <label>Target role<input value={targetRole} onChange={(e) => setTargetRole(e.target.value)} placeholder="e.g. Machine Learning Engineer" /></label>
        <label>Preferred job type<select value={jobType} onChange={(e) => setJobType(e.target.value)}>{JOB_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label>Location preference<input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Remote" /></label>
        <button className="primary-button full" onClick={() => onSave({ targetRole, jobType, location })}>Save preferences <span>→</span></button>
      </div>
    </div>
  );
}

function Dashboard(p: {
  first: string; nav: string; jobType: string; setJobType: (v: string) => void; searchTerm: string; setSearchTerm: (v: string) => void; onSearch: () => void; jobs: Job[]; jobSource: string; jobLoading: boolean; jobError: string;
  profileScore: number; saved: number[]; onSave: (id: number) => void; onQueue: (job: Job) => void; applications: Application[]; reviewCount: number; submittedCount: number; onProfile: () => void; onNav: (n: string) => void;
  hasResume: boolean; agentBusy: boolean; agentResult: AgentResult | null; onRun: (o: { query: string; limit: number; minMatch: number }) => void; defaultQuery: string;
}) {
  const [limit, setLimit] = useState(3); const [minMatch, setMinMatch] = useState(55); const [agentQuery, setAgentQuery] = useState("");
  const hour = new Date().getHours(); const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <div className="content-wrap">
      <section className="welcome-row">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }).toUpperCase()}</p>
          <h1>{greeting}, {p.first}.</h1>
          <p className="subhead">{p.nav === "Job matches" ? "Every listing, ranked against your resume." : "Let the agent search, match and draft. You approve every application."}</p>
        </div>
        <button className="profile-button" onClick={p.onProfile}><span className="avatar">{p.first.slice(0, 1).toUpperCase()}</span><span>Profile <strong>{p.profileScore}%</strong></span><span className="progress-ring">↗</span></button>
      </section>
      <section className="metrics-grid" aria-label="Application summary">
        <article className="metric-card accent-card"><div className="metric-label">LISTINGS FOUND <span className="live-dot" /></div><div className="metric-number">{p.jobs.length}</div><div className="metric-foot"><span>{p.jobType === "All types" ? "ranked by resume match" : `${p.jobType.toLowerCase()} roles shown`}</span><span className="trend">{p.jobSource}</span></div></article>
        <article className="metric-card"><div className="metric-label">IN PROGRESS</div><div className="metric-number">{p.applications.length}</div><div className="metric-foot"><span>tracked applications</span></div><div className="status-line"><span className="status-dot orange" />{p.reviewCount} awaiting review</div><div className="status-line"><span className="status-dot green" />{p.submittedCount} submitted or later</div></article>
        <article className="metric-card"><div className="metric-label">PROFILE SIGNAL</div><div className="metric-number">{p.profileScore}<span className="percent">%</span></div><div className="metric-foot"><span>role, resume, location</span></div><div className="signal-track"><span style={{ width: `${p.profileScore}%` }} /></div><div className="signal-caption">{p.profileScore >= 80 ? "Strong" : p.profileScore >= 55 ? "Promising" : "Add your resume to improve matching"}</div></article>
      </section>
      <section className="agent-panel">
        <div><p className="eyebrow">JOB AGENT</p><h2>Find, match and draft for me</h2>
          <p className="subhead">Searches live listings, scores each against your resume, drafts a truthful summary and cover letter, then queues them for your approval.</p></div>
        {p.hasResume ? (
          <div className="agent-controls">
            <label>Search<input value={agentQuery} placeholder={p.defaultQuery || "Role or keywords"} onChange={(e) => setAgentQuery(e.target.value)} /></label>
            <label>Max drafts<select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[1, 3, 5, 10].map((n) => <option key={n}>{n}</option>)}</select></label>
            <label>Min match<select value={minMatch} onChange={(e) => setMinMatch(Number(e.target.value))}>{[40, 55, 70, 85].map((n) => <option key={n} value={n}>{n}%</option>)}</select></label>
            <button className="primary-button" disabled={p.agentBusy} onClick={() => p.onRun({ query: agentQuery || p.defaultQuery, limit, minMatch })}>{p.agentBusy ? "Agent working..." : "Run agent"}<span>→</span></button>
          </div>
        ) : <div className="integration-note"><strong>Resume needed.</strong><span>Import or paste your resume in Resume studio so the agent can match honestly.</span><button className="secondary-button" onClick={() => p.onNav("Resume studio")}>Open Resume studio</button></div>}
        {p.agentResult && <div className="agent-result"><strong>Last run:</strong> scanned {p.agentResult.found} listings from {p.agentResult.source}; drafted {p.agentResult.queued.length}; {p.agentResult.skipped} already tracked; {p.agentResult.belowThreshold} below {p.agentResult.minMatch}%.
          {p.agentResult.queued.map((a) => <button key={a.id} className="text-button" onClick={() => p.onNav("Applications")}>{a.job.role} · {a.job.company} ({a.match}%) →</button>)}</div>}
      </section>
      <section className="section-heading">
        <div><p className="eyebrow">CURATED FOR YOU · {p.jobSource.toUpperCase()}</p><h2>Worth a closer look <span className="spark">✦</span></h2></div>
        <div className="match-controls">
          <label htmlFor="job-search">SEARCH</label>
          <input id="job-search" className="job-search" value={p.searchTerm} onChange={(e) => p.setSearchTerm(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") p.onSearch(); }} placeholder="Role or company" />
          <button className="search-button" onClick={p.onSearch}>Search jobs</button>
          <label htmlFor="job-type-filter">JOB TYPE</label>
          <select id="job-type-filter" value={p.jobType} onChange={(e) => p.setJobType(e.target.value)}>{JOB_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        </div>
      </section>
      {p.jobError && <div className="integration-note error-note"><strong>Search problem</strong><span>{p.jobError}</span></div>}
      <section className="jobs-grid">
        {p.jobLoading ? <div className="empty-state">Searching jobs...</div> : p.jobs.length ? (p.nav === "Job matches" ? p.jobs : p.jobs.slice(0, 6)).map((job) => (
          <JobCard key={job.id} job={job} saved={p.saved.includes(job.id)} tracked={p.applications.some((a) => a.jobId === job.id)} onSave={() => p.onSave(job.id)} onQueue={() => p.onQueue(job)} />
        )) : <div className="empty-state">No {p.jobType.toLowerCase()} matches for this search. Try different keywords.</div>}
      </section>
      {p.nav !== "Job matches" && p.jobs.length > 6 && <button className="text-button" onClick={() => p.onNav("Job matches")}>View all {p.jobs.length} matches <span>→</span></button>}
      <section className="bottom-grid">
        <article className="activity-panel">
          <div className="section-heading compact"><div><p className="eyebrow">YOUR MOMENTUM</p><h2>Application activity</h2></div><button className="text-button" onClick={() => p.onNav("Applications")}>See all <span>→</span></button></div>
          <div className="activity-list">
            {p.applications.length ? p.applications.slice(0, 4).map((a) => (
              <div className="activity-item" key={a.id}>
                <span className={`activity-icon ${a.status === "Review" ? "purple" : "green"}`}>{a.status === "Review" ? "✦" : "✓"}</span>
                <span><strong>{a.status === "Review" ? "Draft ready for review" : `Application ${a.status.toLowerCase()}`}</strong><small>{a.job.company} · {when(a.updatedAt)}</small></span>
                <span className={`activity-state ${a.status === "Review" ? "ready" : "done"}`}>{a.status}</span>
              </div>
            )) : <div className="empty-state">No applications yet. Run the agent or queue a job above.</div>}
          </div>
        </article>
        <article className="next-panel">
          <div className="next-orbit">✦</div><p className="eyebrow">NEXT BEST ACTION</p>
          <h2>{p.reviewCount ? <>Review {p.reviewCount} draft{p.reviewCount === 1 ? "" : "s"}<br />before they go anywhere.</> : <>Run the agent<br />to fill your queue.</>}</h2>
          <p>{p.reviewCount ? "Edit the cover letter, then approve and apply." : "It only drafts. You decide what gets sent."}</p>
          <button className="primary-button" onClick={() => p.onNav(p.reviewCount ? "Applications" : "Resume studio")}>{p.reviewCount ? "Open review queue" : "Open resume studio"} <span>→</span></button>
        </article>
      </section>
    </div>
  );
}

function JobCard({ job, saved, tracked, onSave, onQueue }: { job: Job; saved: boolean; tracked: boolean; onSave: () => void; onQueue: () => void }) {
  return (
    <article className="job-card">
      <div className="job-top"><div className={`company-logo ${color(job)}`}>{initials(job)}</div><button className={saved ? "save-button saved" : "save-button"} onClick={onSave} aria-label="Save job">{saved ? "★" : "☆"}</button></div>
      <div className="match-pill">{job.match ?? 0}% match</div>
      <h3>{job.role}</h3><p className="company-name">{job.company}</p>
      {job.matchedSkills?.length ? <p className="matched">Matches: {job.matchedSkills.slice(0, 3).join(", ")}</p> : null}
      {job.url && <a className="listing-link" href={job.url} target="_blank" rel="noreferrer">Open listing ↗</a>}
      <div className="job-details"><span className="job-type">{job.type}</span><span>⌖ {job.location}</span><span>◷ {job.posted}</span></div>
      <div className="job-footer"><span>{job.salary}</span><button className="arrow-button" onClick={onQueue} disabled={tracked} title={tracked ? "Already in your queue" : "Draft application"}>{tracked ? "✓" : "↗"}</button></div>
    </article>
  );
}

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

function ResumeStudio({ profile, user, jobs, applications, focusJob, onFocus, onResume, onFile, onQueue, onSaved, api, onNotice }: {
  profile: Profile; user: User; jobs: Job[]; applications: Application[]; focusJob: Job | null; onFocus: (j: Job | null) => void; onResume: (t: string) => void; onFile: (e: ChangeEvent<HTMLInputElement>) => void;
  onQueue: (j: Job) => void; onSaved: (a: Application) => void; api: Api; onNotice: (m: string) => void;
}) {
  const options = [...applications.map((a) => a.job), ...jobs.filter((j) => !applications.some((a) => a.jobId === j.id))];
  const job = focusJob ?? options[0] ?? null;
  const app = job ? applications.find((a) => a.jobId === job.id) : undefined;
  const [summary, setSummary] = useState(""); const [letter, setLetter] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { setSummary(app?.summary ?? ""); setLetter(app?.coverLetter ?? ""); }, [app?.id, app?.updatedAt, app?.summary, app?.coverLetter]);
  const regenerate = async () => {
    if (!job) return; setBusy(true);
    try {
      const body = app ? { applicationId: app.id } : { job };
      const t = await api<{ summary: string; coverLetter: string; generatedBy: string }>("/api/tailor", "POST", body);
      setSummary(t.summary); setLetter(t.coverLetter);
      if (app) onSaved({ ...app, summary: t.summary, coverLetter: t.coverLetter, generatedBy: t.generatedBy });
      onNotice(`Draft generated by ${t.generatedBy}.`);
    } catch (e) { onNotice(e instanceof Error ? e.message : "Tailoring failed"); } finally { setBusy(false); }
  };
  const saveEdits = async () => { if (!app) return; try { onSaved(await api<Application>(`/api/applications/${app.id}`, "PATCH", { summary, coverLetter: letter })); onNotice("Edits saved."); } catch (e) { onNotice(e instanceof Error ? e.message : "Save failed"); } };
  return (
    <div className="content-wrap studio-wrap">
      <section className="studio-header">
        <div><p className="eyebrow">RESUME STUDIO</p><h1>Make your real experience resonate.</h1><p className="subhead">Orbit reshapes emphasis for a role. You review every word before it leaves this workspace.</p></div>
        <label className="upload-button">↑ Import CV<input type="file" accept=".txt,.md,.pdf,.docx" onChange={onFile} /></label>
      </section>
      <div className="studio-grid">
        <article className="studio-panel">
          <div className="panel-heading"><div><p className="eyebrow">SOURCE MATERIAL</p><h2>{profile.resumeName || "Your resume"}</h2></div><span className="local-badge">Saved to your account</span></div>
          <textarea value={profile.resumeText} onChange={(e) => onResume(e.target.value)} aria-label="Source resume text" placeholder="Import a PDF/DOCX or paste your resume here. The agent only uses facts written here." />
          <p className="field-note">PDF, DOCX, TXT and Markdown are extracted in your browser. Review the text before tailoring.</p>
        </article>
        <article className="studio-panel tailored-panel">
          {job ? <>
            <div className="panel-heading"><div><p className="eyebrow">TAILOR FOR</p>
              <select className="studio-select" value={job.id} onChange={(e) => onFocus(options.find((j) => j.id === Number(e.target.value)) ?? null)}>{options.map((j) => <option value={j.id} key={j.id}>{j.role} · {j.company}</option>)}</select></div>
              <span className="match-pill">{app?.match ?? job.match ?? 0}% match</span></div>
            <div className="tailored-preview">
              <h2>{job.role}</h2><p className="company-name">{job.company} · {job.type}</p>
              {job.skills.length > 0 && <><h3>Role keywords</h3><div className="skill-list">{job.skills.map((s) => <span key={s}>{s}</span>)}</div></>}
              {app ? <>
                <h3>Tailored summary</h3><textarea className="draft-box short" value={summary} onChange={(e) => setSummary(e.target.value)} />
                <h3>Cover letter draft</h3><textarea className="draft-box" value={letter} onChange={(e) => setLetter(e.target.value)} />
                <p className="field-note">Draft source: {app.generatedBy}</p>
              </> : <div className="empty-state">No draft yet. Add this role to your queue and Orbit drafts a summary and cover letter from your resume.</div>}
              <div className="truth-callout">✓ Built only from the resume text on the left. Check every claim before approving.</div>
            </div>
            <div className="panel-actions">
              <button className="secondary-button" onClick={regenerate} disabled={busy || !profile.resumeText.trim()}>{busy ? "Generating..." : "✦ Regenerate"}</button>
              {app && <button className="secondary-button" onClick={saveEdits}>Save edits</button>}
              {app && <button className="secondary-button" onClick={() => downloadText(`${job.company}-cover-letter.txt`, letter)}>↓ Cover letter</button>}
              {app && <button className="secondary-button" onClick={() => downloadText(`${job.company}-resume.txt`, `${user.name}\n${job.role} · ${job.company}\n\n${summary}\n\n${profile.resumeText}`)}>↓ Resume</button>}
              {!app && <button className="primary-button" onClick={() => onQueue(job)} disabled={!profile.resumeText.trim()}>Draft & add to queue <span>→</span></button>}
            </div>
          </> : <div className="empty-state">No jobs loaded yet. Search on the Overview page or run the agent.</div>}
        </article>
      </div>
    </div>
  );
}

function Applications({ applications, onReview, onSubmit, onStatus, onRemove }: { applications: Application[]; onReview: (a: Application) => void; onSubmit: (a: Application) => void; onStatus: (a: Application, s: Status) => void; onRemove: (a: Application) => void }) {
  return (
    <div className="content-wrap applications-wrap">
      <section className="studio-header"><div><p className="eyebrow">APPLICATIONS</p><h1>Your review queue.</h1><p className="subhead">Nothing is marked submitted without your confirmation.</p></div><div className="approval-lock">◉ Approval required</div></section>
      <section className="application-list">
        {applications.length ? applications.map((a) => (
          <article className="application-row" key={a.id}>
            <div className={`company-logo ${color(a.job)}`}>{initials(a.job)}</div>
            <div className="application-main">
              <strong>{a.job.role} <em className="match-inline">{a.match}%</em></strong>
              <span>{a.job.company} · {a.job.type} · {a.job.location} · {a.generatedBy}</span>
              {a.job.url && <a className="listing-link" href={a.job.url} target="_blank" rel="noreferrer">Open listing ↗</a>}
            </div>
            {a.status === "Review" ? <span className="application-status needs-review">Needs review</span> : (
              <select className="studio-select" value={a.status} onChange={(e) => onStatus(a, e.target.value as Status)} aria-label="Update status">{["Submitted", "Interview", "Offer", "Rejected"].map((s) => <option key={s}>{s}</option>)}</select>
            )}
            <button className="secondary-button" onClick={() => onReview(a)}>Review</button>
            {a.status === "Review" && <button className="primary-button" onClick={() => onSubmit(a)}>Approve & apply <span>→</span></button>}
            <button className="secondary-button" onClick={() => onRemove(a)} aria-label="Remove application">✕</button>
          </article>
        )) : <div className="empty-state">Your queue is empty. Run the agent from Overview.</div>}
      </section>
      <div className="integration-note"><strong>How applying works.</strong><span>“Approve & apply” opens the real listing in a new tab. After you submit there, confirm in Orbit and it records the submission. Orbit does not auto-submit to third-party job boards.</span></div>
    </div>
  );
}

function Reports({ api, onNotice }: { api: Api; onNotice: (m: string) => void }) {
  const [report, setReport] = useState<Report | null>(null); const [error, setError] = useState("");
  useEffect(() => { api<Report>("/api/reports").then(setReport).catch(() => setError("Reports could not be loaded.")); }, [api]);
  const exportMd = async () => {
    try { const res = await fetch("/api/reports/export", { headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ""}` } }); if (!res.ok) throw new Error(); downloadText("orbit-sdlc-report.md", await res.text()); } catch { onNotice("Export failed."); }
  };
  return (
    <div className="content-wrap reports-wrap">
      <section className="studio-header"><div><p className="eyebrow">SDLC REPORTS</p><h1>Search to submission pipeline.</h1><p className="subhead">Requirements, discovery, tailoring, review, submission and outcome, computed from your real records.</p></div><button className="secondary-button" onClick={exportMd} disabled={!report}>↓ Export report</button></section>
      {error ? <div className="integration-note error-note">{error}</div> : !report ? <div className="empty-state">Loading report...</div> : <>
        <section className="report-totals">
          {[["APPLICATIONS", report.totals.applications], ["NEEDS REVIEW", report.totals.review], ["SUBMITTED", report.totals.submitted], ["INTERVIEW / OFFER", report.totals.outcomes], ["AGENT RUNS", report.totals.agentRuns], ["AVG MATCH", `${report.totals.avgMatch}%`]].map(([label, value]) => <article key={String(label)}><span>{label}</span><strong>{value}</strong></article>)}
        </section>
        <section className="report-stages">
          {report.stages.map((s) => (
            <article className="report-stage" key={s.name}>
              <div className={`stage-mark ${s.status}`}>{s.status === "complete" ? "✓" : "•"}</div>
              <div><p className="eyebrow">STAGE</p><h2>{s.name}</h2><p>{s.detail}</p></div><span>{s.status}</span>
            </article>
          ))}
        </section>
        <section className="activity-panel timeline">
          <div className="section-heading compact"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Recent activity</h2></div></div>
          {report.events.length ? report.events.map((e) => <div className="timeline-row" key={e.id}><span className="local-badge">{e.stage}</span><span>{e.message}</span><small>{when(e.createdAt)}</small></div>) : <div className="empty-state">No activity yet.</div>}
        </section>
        <p className="field-note">Generated {new Date(report.generatedAt).toLocaleString()} from the Orbit API and SQLite records.</p>
      </>}
    </div>
  );
}

export default App;
