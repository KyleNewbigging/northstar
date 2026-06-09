/* ============================================================
   NORTHSTAR — mock data (plain JS, sets window.NS)
   ============================================================ */
(function () {
  const projects = [
    {
      id: "atlas", name: "atlas-api", path: "~/dev/atlas-api",
      branch: "main", lang: "TypeScript", status: "running",
      health: 0.94, agentsActive: 3, openTasks: 7, queued: 4,
      lastEvent: "agent patched rate-limiter", lastAgo: "2m",
      commits24: 18, linesNet: "+1,204 / −388", coverage: 0.81,
      tokens: 412000, budget: 1000000, runtime: "4h 12m",
      nodes: 1284, communities: 9,
      spark: [3,5,4,7,6,9,8,7,9,12,10,14],
    },
    {
      id: "nebula", name: "nebula-web", path: "~/dev/nebula-web",
      branch: "feat/checkout-v2", lang: "TypeScript", status: "needs-input",
      health: 0.71, agentsActive: 1, openTasks: 12, queued: 2,
      lastEvent: "clarify: which payment SDK?", lastAgo: "just now",
      commits24: 9, linesNet: "+602 / −145", coverage: 0.67,
      tokens: 188000, budget: 600000, runtime: "1h 48m",
      nodes: 892, communities: 7,
      spark: [6,5,7,6,4,5,6,5,7,6,8,7],
    },
    {
      id: "pulsar", name: "pulsar-infra", path: "~/dev/pulsar-infra",
      branch: "main", lang: "Go", status: "running",
      health: 0.88, agentsActive: 2, openTasks: 4, queued: 1,
      lastEvent: "drafting terraform module", lastAgo: "6m",
      commits24: 5, linesNet: "+318 / −92", coverage: 0.74,
      tokens: 96000, budget: 500000, runtime: "2h 03m",
      nodes: 503, communities: 5,
      spark: [2,3,2,4,3,5,4,6,5,4,6,5],
    },
    {
      id: "quasar", name: "quasar-ml", path: "~/dev/quasar-ml",
      branch: "exp/retrieval", lang: "Python", status: "blocked",
      health: 0.52, agentsActive: 0, openTasks: 9, queued: 3,
      lastEvent: "build failed: cuda mismatch", lastAgo: "21m",
      commits24: 2, linesNet: "+88 / −410", coverage: 0.59,
      tokens: 244000, budget: 800000, runtime: "0h 51m",
      nodes: 1640, communities: 11,
      spark: [8,7,9,6,5,4,3,2,3,2,1,2],
    },
    {
      id: "comet", name: "comet-cli", path: "~/dev/comet-cli",
      branch: "main", lang: "Rust", status: "idle",
      health: 0.97, agentsActive: 0, openTasks: 1, queued: 0,
      lastEvent: "all checks green", lastAgo: "1h",
      commits24: 11, linesNet: "+0 / −0", coverage: 0.9,
      tokens: 31000, budget: 300000, runtime: "—",
      nodes: 367, communities: 4,
      spark: [4,5,4,5,4,4,5,4,4,4,4,4],
    },
    {
      id: "orion", name: "orion-mobile", path: "~/dev/orion-mobile",
      branch: "feat/offline-sync", lang: "Swift", status: "running",
      health: 0.83, agentsActive: 2, openTasks: 6, queued: 2,
      lastEvent: "writing migration tests", lastAgo: "4m",
      commits24: 7, linesNet: "+540 / −201", coverage: 0.72,
      tokens: 151000, budget: 600000, runtime: "3h 27m",
      nodes: 1021, communities: 8,
      spark: [3,4,5,6,5,7,6,8,7,9,8,10],
    },
  ];

  const MODELS = [
    { id: "opus", label: "Claude Opus 4.7", vendor: "Anthropic", local: false, tier: "frontier" },
    { id: "codex", label: "Codex 5.5", vendor: "OpenAI", local: false, tier: "frontier" },
    { id: "spark", label: "Spark", vendor: "Local", local: true, tier: "fast" },
  ];

  const queue = [
    { id: "T-1042", title: "Patch rate-limiter to use sliding window", project: "atlas", model: "opus",
      status: "running", progress: 0.62, priority: "P1", eta: "~3m", agent: "builder",
      stage: "writing patch", files: 4, branch: "agent/rate-limiter" },
    { id: "T-1039", title: "Migrate checkout to Payments SDK v3", project: "nebula", model: "codex",
      status: "needs-input", progress: 0.30, priority: "P0", eta: "blocked", agent: "builder",
      stage: "awaiting clarification", files: 9, branch: "agent/checkout-v2" },
    { id: "T-1051", title: "Generate terraform module for vpc-peering", project: "pulsar", model: "spark",
      status: "running", progress: 0.45, priority: "P2", eta: "~6m", agent: "drafter",
      stage: "drafting", files: 3, branch: "agent/vpc-peering" },
    { id: "T-1033", title: "Fix CUDA version mismatch in training image", project: "quasar", model: "opus",
      status: "blocked", progress: 0.15, priority: "P1", eta: "blocked", agent: "fixer",
      stage: "build failed", files: 2, branch: "agent/cuda-fix" },
    { id: "T-1048", title: "Add offline write queue + conflict resolver", project: "orion", model: "codex",
      status: "running", progress: 0.78, priority: "P1", eta: "~2m", agent: "builder",
      stage: "running tests", files: 6, branch: "agent/offline-sync" },
    { id: "T-1055", title: "Refactor auth middleware into composable guards", project: "atlas", model: "spark",
      status: "queued", progress: 0, priority: "P2", eta: "queued", agent: "builder",
      stage: "waiting for slot", files: 0, branch: "—" },
    { id: "T-1056", title: "Write integration tests for sync resolver", project: "orion", model: "opus",
      status: "queued", progress: 0, priority: "P2", eta: "queued", agent: "tester",
      stage: "depends on T-1048", files: 0, branch: "—" },
    { id: "T-1031", title: "Document public API surface for v2", project: "atlas", model: "spark",
      status: "queued", progress: 0, priority: "P3", eta: "queued", agent: "scribe",
      stage: "low priority", files: 0, branch: "—" },
    { id: "T-1029", title: "Bump deps & resolve advisories", project: "comet", model: "spark",
      status: "done", progress: 1, priority: "P3", eta: "done", agent: "fixer",
      stage: "merged", files: 5, branch: "agent/deps-bump" },
  ];

  const inbox = [
    { id: "Q-204", project: "nebula", task: "T-1039", model: "codex", ago: "just now", urgency: "high",
      q: "The checkout flow references two payment SDKs. Which should v3 standardize on?",
      ctx: "Found imports of both @acme/pay-legacy and @acme/payments in 4 files.",
      options: ["@acme/payments (v3)", "@acme/pay-legacy", "Let me decide per-file"] },
    { id: "Q-201", project: "quasar", task: "T-1033", model: "opus", ago: "18m", urgency: "high",
      q: "Pin CUDA to 12.4 to match the cluster, or upgrade the cluster to 12.6?",
      ctx: "Training image expects 12.6; runners provision 12.4.",
      options: ["Pin image to 12.4", "Upgrade runners to 12.6", "Investigate further"] },
    { id: "Q-198", project: "atlas", task: "T-1055", model: "spark", ago: "33m", urgency: "med",
      q: "Should guards short-circuit on first failure or collect all auth errors?",
      ctx: "Affects error payload shape for the public API.",
      options: ["Short-circuit", "Collect all", "Match existing behavior"] },
    { id: "Q-195", project: "orion", task: "T-1048", model: "codex", ago: "1h", urgency: "low",
      q: "Conflict resolution default: last-write-wins or prompt the user?",
      ctx: "Offline edits to the same record need a tiebreak policy.",
      options: ["Last-write-wins", "Prompt user", "Field-level merge"] },
  ];

  // ----- graph cockpit (graphify-inspired knowledge graph for atlas-api) -----
  const COMMS = [
    { id: 0, name: "http/routing",   color: "var(--c2)" },
    { id: 1, name: "auth",           color: "var(--c1)" },
    { id: 2, name: "data/orm",       color: "var(--c4)" },
    { id: 3, name: "rate-limit",     color: "var(--c5)" },
    { id: 4, name: "config",         color: "var(--c6)" },
    { id: 5, name: "observability",  color: "var(--c3)" },
  ];
  // hand-placed layout (force-directed look) on a 1000x680 field
  const gnodes = [
    { id: "Server",        c: 0, x: 500, y: 120, deg: 14, kind: "god" },
    { id: "Router",        c: 0, x: 410, y: 210, deg: 11, kind: "god" },
    { id: "RequestCtx",    c: 0, x: 590, y: 220, deg: 7,  kind: "file" },
    { id: "middleware()",  c: 0, x: 480, y: 300, deg: 9,  kind: "fn" },
    { id: "AuthGuard",     c: 1, x: 250, y: 330, deg: 8,  kind: "god", agent: true },
    { id: "JWT.verify",    c: 1, x: 160, y: 250, deg: 5,  kind: "fn" },
    { id: "Session",       c: 1, x: 200, y: 430, deg: 4,  kind: "file" },
    { id: "RateLimiter",   c: 3, x: 700, y: 330, deg: 9,  kind: "god", agent: true, hot: true },
    { id: "SlidingWindow", c: 3, x: 800, y: 270, deg: 3,  kind: "fn", agent: true },
    { id: "TokenBucket",   c: 3, x: 800, y: 410, deg: 4,  kind: "fn" },
    { id: "ORM",           c: 2, x: 470, y: 470, deg: 12, kind: "god" },
    { id: "UserModel",     c: 2, x: 380, y: 560, deg: 6,  kind: "file" },
    { id: "Migration",     c: 2, x: 560, y: 560, deg: 5,  kind: "file" },
    { id: "Pool",          c: 2, x: 470, y: 600, deg: 4,  kind: "fn" },
    { id: "Config",        c: 4, x: 640, y: 470, deg: 7,  kind: "god" },
    { id: "env.load",      c: 4, x: 720, y: 540, deg: 3,  kind: "fn" },
    { id: "Logger",        c: 5, x: 330, y: 150, deg: 6,  kind: "file" },
    { id: "Tracer",        c: 5, x: 250, y: 95,  deg: 4,  kind: "fn" },
    { id: "Metrics",       c: 5, x: 660, y: 180, deg: 5,  kind: "file" },
  ];
  const gedges = [
    ["Server","Router","ext"], ["Server","middleware()","ext"], ["Server","Logger","ext"],
    ["Router","RequestCtx","ext"], ["Router","middleware()","ext"], ["Router","AuthGuard","ext"],
    ["Router","RateLimiter","ext"], ["middleware()","AuthGuard","ext"], ["middleware()","RateLimiter","ext"],
    ["AuthGuard","JWT.verify","ext"], ["AuthGuard","Session","ext"], ["AuthGuard","ORM","inf"],
    ["RateLimiter","SlidingWindow","ext"], ["RateLimiter","TokenBucket","ext"], ["RateLimiter","Config","ext"],
    ["RateLimiter","Metrics","inf"], ["ORM","UserModel","ext"], ["ORM","Migration","ext"],
    ["ORM","Pool","ext"], ["ORM","Config","inf"], ["Config","env.load","ext"],
    ["Config","Server","amb"], ["Logger","Tracer","ext"], ["Server","Metrics","inf"],
    ["RequestCtx","Session","amb"], ["Metrics","Tracer","inf"],
  ];

  // ----- patch review (atlas rate-limiter task T-1042) -----
  const patch = {
    task: "T-1042", title: "Patch rate-limiter to use sliding window",
    project: "atlas", model: "opus", branch: "agent/rate-limiter",
    base: "main", worktree: "~/dev/.worktrees/atlas-rate-limiter",
    summary: "Replaces the fixed-window counter with a sliding-window log to remove burst bypass at window edges. Adds Config-driven limits and Metrics hooks.",
    additions: 96, deletions: 41, filesChanged: 4, checks: [
      { name: "lint", state: "pass", ms: 1200 },
      { name: "typecheck", state: "pass", ms: 4300 },
      { name: "unit", state: "pass", ms: 8800, detail: "142 passed" },
      { name: "integration", state: "running", ms: 0, detail: "running 18/24" },
    ],
    files: [
      { path: "src/ratelimit/SlidingWindow.ts", add: 58, del: 2, status: "new" },
      { path: "src/ratelimit/RateLimiter.ts", add: 24, del: 31, status: "mod" },
      { path: "src/config/limits.ts", add: 11, del: 0, status: "mod" },
      { path: "src/ratelimit/TokenBucket.ts", add: 3, del: 8, status: "del-partial" },
    ],
    diff: [
      { t: "hunk", s: "src/ratelimit/RateLimiter.ts" },
      { t: "ctx", n1: 11, n2: 11, s: "export class RateLimiter {" },
      { t: "ctx", n1: 12, n2: 12, s: "  constructor(private cfg: LimitConfig) {" },
      { t: "del", n1: 13, s: "    this.window = new FixedWindow(cfg.windowMs);" },
      { t: "add", n2: 13, s: "    this.window = new SlidingWindow(cfg.windowMs, cfg.max);" },
      { t: "ctx", n1: 14, n2: 14, s: "  }" },
      { t: "ctx", n1: 15, n2: 15, s: "" },
      { t: "del", n1: 16, s: "  allow(key: string): boolean {" },
      { t: "del", n1: 17, s: "    const count = this.window.hit(key);" },
      { t: "del", n1: 18, s: "    return count <= this.cfg.max;" },
      { t: "add", n2: 16, s: "  allow(key: string): RateDecision {" },
      { t: "add", n2: 17, s: "    const { allowed, remaining, resetMs } = this.window.hit(key);" },
      { t: "add", n2: 18, s: "    metrics.observe('ratelimit.remaining', remaining, { key });" },
      { t: "add", n2: 19, s: "    return { allowed, remaining, resetMs };" },
      { t: "ctx", n1: 19, n2: 20, s: "  }" },
      { t: "ctx", n1: 20, n2: 21, s: "}" },
    ],
    rationale: [
      "Fixed windows let a client send 2× the limit across a window boundary. A sliding-window log keeps per-key timestamps and evicts expired ones, so the rate is enforced continuously.",
      "Limits now read from Config (src/config/limits.ts) so they can be tuned per-route without a redeploy.",
      "Added a Metrics hook (ratelimit.remaining) — surfaces in the observability community in the graph.",
    ],
    risks: [
      { level: "med", text: "Sliding window holds timestamps in memory; high-cardinality keys grow heap. Capped at 10k keys with LRU eviction." },
      { level: "low", text: "Return type changed boolean → RateDecision. 2 callers updated; no external API change." },
    ],
  };

  // ----- work/personal labels per project -----
  const PROJECT_LABEL = {
    atlas: "work", nebula: "work", pulsar: "work",
    orion: "work", quasar: "personal", comet: "personal",
  };
  projects.forEach(p => { p.label = PROJECT_LABEL[p.id]; });

  // ----- unified action inbox (everything that needs the human) -----
  // type: question | review | blocked | suggest
  const actions = [
    { id: "A-01", type: "question", project: "nebula", task: "T-1039", model: "codex",
      priority: "P0", ago: "just now", urgency: "high",
      title: "Which payment SDK should checkout v3 standardize on?",
      ctx: "Found imports of both @acme/pay-legacy and @acme/payments across 4 files. The migration can't proceed until this is pinned.",
      options: ["@acme/payments (v3)", "@acme/pay-legacy", "Let me decide per-file"],
      recommend: 0, help: "v3 is the actively maintained SDK — legacy hits EOL in Q3 and lacks the 3DS2 flow your EU traffic needs. I'd standardize on @acme/payments and codemod the 4 call sites (~30 min, low risk)." },

    { id: "A-02", type: "blocked", project: "quasar", task: "T-1033", model: "opus",
      priority: "P1", ago: "21m", urgency: "high",
      title: "Training build failed — CUDA 12.6 image vs 12.4 runners",
      ctx: "The training image expects CUDA 12.6 but CI runners provision 12.4. The job has retried twice and is holding the queue.",
      options: ["Pin image to CUDA 12.4", "Upgrade runners to 12.6", "Investigate further"],
      recommend: 0, help: "Pinning the image to 12.4 unblocks you in one commit and matches the rest of the fleet. Upgrading runners touches shared infra and would block 3 other projects — not worth it for an experiment branch." },

    { id: "A-03", type: "review", project: "atlas", task: "T-1042", model: "opus",
      priority: "P1", ago: "2m", urgency: "med",
      title: "Patch ready — RateLimiter → sliding window",
      ctx: "Sliding-window log replaces the fixed-window counter. 4 files, +96/−41. lint, typecheck & unit green; integration running 18/24.",
      add: 96, del: 41, files: 4, opensReview: true },

    { id: "A-04", type: "suggest", project: "atlas", task: null, model: "spark",
      priority: "P2", ago: "9m", urgency: "med",
      title: "Found a 38% token saving on the atlas indexing run",
      ctx: "Spark noticed the graph re-indexes unchanged files every run. Scoping extraction to the git diff would cut indexing tokens ~38% (≈ 160k/day) with no quality loss.",
      options: ["Apply optimization", "Not now"],
      recommend: 0, help: "This is pure upside — incremental extraction is already supported, it just isn't enabled for atlas. I can turn it on and verify the graph is identical on the next commit." },

    { id: "A-05", type: "question", project: "atlas", task: "T-1055", model: "spark",
      priority: "P2", ago: "33m", urgency: "med",
      title: "Auth guards: short-circuit or collect all errors?",
      ctx: "Refactor into composable guards. Behavior affects the public API error payload shape.",
      options: ["Short-circuit on first failure", "Collect all auth errors", "Match existing behavior"],
      recommend: 2, help: "Matching existing behavior keeps the public contract stable and avoids a breaking change for API consumers. We can revisit collect-all behind a flag later." },

    { id: "A-06", type: "review", project: "orion", task: "T-1048", model: "codex",
      priority: "P2", ago: "4m", urgency: "low",
      title: "Patch ready — offline write queue + conflict resolver",
      ctx: "Adds an offline write queue with last-write-wins resolution. 6 files, +540/−201. All checks green.",
      add: 540, del: 201, files: 6, opensReview: true },

    { id: "A-07", type: "suggest", project: "comet", task: null, model: "spark",
      priority: "P3", ago: "1h", urgency: "low",
      title: "deps-bump merged clean — open the release PR?",
      ctx: "All advisories resolved and checks are green on comet-cli. I can cut v2.4.0 and draft release notes from the changelog.",
      options: ["Open release PR", "Hold"],
      recommend: 0, help: "Nothing is blocking the release and the diff is dependency-only. I'll draft notes you can edit before it goes out." },

    { id: "A-08", type: "question", project: "orion", task: "T-1048", model: "codex",
      priority: "P3", ago: "1h", urgency: "low",
      title: "Conflict resolution default for offline edits?",
      ctx: "Two offline edits to the same record need a tiebreak policy.",
      options: ["Last-write-wins", "Prompt the user", "Field-level merge"],
      recommend: 0, help: "Last-write-wins is the least surprising default and matches how the rest of the app syncs. Field-level merge is nice but a bigger lift — log it as a follow-up." },
  ];

  window.NS = { projects, MODELS, queue, inbox, actions, COMMS, gnodes, gedges, patch };
})();
