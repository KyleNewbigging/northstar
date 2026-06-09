/* ============================================================
   NORTHSTAR — Dashboard (flight deck)   window.SCREENS.Dashboard
   ============================================================ */
const { Icon: DIcon, Spark, Ring, StatusTag, ModelChip: DModelChip, fmtNum, pct } = window.UI;

function StatTile({ label, value, sub, accent, icon, spark }) {
  return (
    <div className="panel brackets stat-tile">
      <div className="row gap8" style={{ justifyContent: "space-between" }}>
        <span className="eyebrow">{label}</span>
        {icon && <DIcon name={icon} size={14} style={{ color: accent || "var(--ink-3)" }}/>}
      </div>
      <div className="row gap10" style={{ alignItems: "flex-end", marginTop: 8 }}>
        <span className="tnum" style={{ fontSize: 30, fontWeight: 500, lineHeight: 1, color: accent || "var(--ink)" }}>{value}</span>
        {spark && <div style={{ marginBottom: 2 }}><Spark data={spark} w={70} h={22} color={accent}/></div>}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>{sub}</div>
    </div>
  );
}

function ProjectCard({ p, onOpen }) {
  const s = window.UI.STATUS[p.status];
  return (
    <button className="panel brackets proj-card" onClick={() => onOpen(p)}>
      <div className="row gap10" style={{ justifyContent: "space-between" }}>
        <div className="row gap8 grow" style={{ minWidth: 0 }}>
          <Ring value={p.health} size={36} stroke={3}/>
          <div className="col grow" style={{ minWidth: 0, lineHeight: 1.2 }}>
            <span className="mono proj-name">{p.name}</span>
            <span className="row gap6" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
              <DIcon name="branch" size={11}/> {p.branch}
              <span className={"lbl lbl-" + p.label}>{p.label}</span>
            </span>
          </div>
        </div>
        <StatusTag status={p.status}/>
      </div>

      <div className="proj-meta">
        <div className="pm"><span className="eyebrow">LANG</span><span className="mono">{p.lang}</span></div>
        <div className="pm"><span className="eyebrow">NODES</span><span className="tnum">{fmtNum(p.nodes)}</span></div>
        <div className="pm"><span className="eyebrow">COV</span><span className="tnum">{pct(p.coverage)}</span></div>
        <div className="pm"><span className="eyebrow">RUNTIME</span><span className="tnum">{p.runtime}</span></div>
      </div>

      <div className="row gap8" style={{ margin: "2px 0 4px" }}>
        <Spark data={p.spark} w={120} h={26} color={p.status === "blocked" ? "var(--err)" : "var(--star)"}/>
        <div className="grow"></div>
        <div className="col" style={{ alignItems: "flex-end", lineHeight: 1.2, flex: "none" }}>
          <span className="tnum" style={{ fontSize: 11, color: "var(--ink-2)", whiteSpace: "nowrap" }}>{p.linesNet}</span>
          <span className="eyebrow" style={{ fontSize: 9 }}>24H NET</span>
        </div>
      </div>

      <div className="proj-foot">
        <div className="row gap8" style={{ minWidth: 0 }}>
          {p.agentsActive > 0
            ? <span className="tag" style={{ color: "var(--star)", borderColor: "var(--star-dim)" }}>
                <i className="dot dot-run live"></i>{p.agentsActive} AGENT{p.agentsActive>1?"S":""}
              </span>
            : <span className="tag"><i className="dot dot-idle"></i>IDLE</span>}
          <span className="row gap4" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
            <DIcon name="queue" size={11}/>{p.openTasks} open · {p.queued} queued
          </span>
        </div>
        <span className="proj-event mono" title={p.lastEvent}>{p.lastEvent}<span style={{ color: "var(--ink-4)" }}> · {p.lastAgo}</span></span>
      </div>

      {/* token budget bar */}
      <div className="meter" style={{ marginTop: 2 }}>
        <i style={{ width: pct(p.tokens / p.budget) }}></i>
      </div>
    </button>
  );
}

function ProjectRow({ p, onOpen }) {
  return (
    <button className="proj-row" onClick={() => onOpen(p)}>
      <Ring value={p.health} size={26} stroke={2.5}/>
      <span className="mono proj-name" style={{ width: 130 }}>{p.name}</span>
      <span className={"lbl lbl-" + p.label}>{p.label}</span>
      <StatusTag status={p.status}/>
      <span className="row gap4 mono" style={{ width: 150, fontSize: 11, color: "var(--ink-3)" }}>
        <DIcon name="branch" size={11}/>{p.branch}
      </span>
      <span className="tnum" style={{ width: 60, color: "var(--ink-2)" }}>{p.lang}</span>
      <div style={{ width: 110 }}><Spark data={p.spark} w={100} h={18} color={p.status==="blocked"?"var(--err)":"var(--star)"}/></div>
      <span className="tnum" style={{ width: 56, textAlign: "right" }}>{pct(p.coverage)}</span>
      <span className="tnum" style={{ width: 64, textAlign: "right" }}>{fmtNum(p.nodes)}</span>
      <span className="grow"></span>
      <span className="row gap6" style={{ minWidth: 0 }}>
        {p.agentsActive>0 && <span className="tag" style={{ color: "var(--star)", borderColor: "var(--star-dim)" }}><i className="dot dot-run live"></i>{p.agentsActive}</span>}
        <span className="proj-event mono" style={{ maxWidth: 200 }}>{p.lastEvent} · {p.lastAgo}</span>
      </span>
    </button>
  );
}

const FEED = [
  { ago: "now",  proj: "nebula", model: "codex", txt: "needs input — which payment SDK?", kind: "input" },
  { ago: "2m",   proj: "atlas",  model: "opus",  txt: "patched RateLimiter → sliding window", kind: "patch" },
  { ago: "4m",   proj: "orion",  model: "codex", txt: "writing migration tests (6 files)", kind: "run" },
  { ago: "6m",   proj: "pulsar", model: "spark", txt: "drafting terraform vpc-peering", kind: "run" },
  { ago: "12m",  proj: "atlas",  model: "spark", txt: "opened PR agent/auth-guards", kind: "pr" },
  { ago: "21m",  proj: "quasar", model: "opus",  txt: "build failed — cuda mismatch", kind: "err" },
  { ago: "34m",  proj: "comet",  model: "spark", txt: "merged deps-bump · all green", kind: "done" },
  { ago: "47m",  proj: "atlas",  model: "opus",  txt: "indexed graph · 1,284 nodes / 9 comms", kind: "graph" },
];
const FEED_ICON = { input: "alert", patch: "review", run: "bolt", pr: "branch", err: "alert", done: "check", graph: "graph" };
const FEED_COLOR = { input: "var(--cyan)", patch: "var(--star)", run: "var(--star)", pr: "var(--ink-2)", err: "var(--err)", done: "var(--ok)", graph: "var(--c3)" };

function ActivityFeed() {
  return (
    <div className="panel brackets col" style={{ overflow: "hidden" }}>
      <div className="panel-hd"><DIcon name="bolt" size={14} style={{ color: "var(--star)" }}/><h3>Telemetry Stream</h3><span className="grow"></span><i className="dot dot-run live"></i></div>
      <div className="scroll grow" style={{ padding: "6px 4px" }}>
        {FEED.map((f, i) => (
          <div key={i} className="feed-row">
            <span className="tnum feed-time">{f.ago}</span>
            <DIcon name={FEED_ICON[f.kind]} size={13} style={{ color: FEED_COLOR[f.kind], flex: "none", marginTop: 2 }}/>
            <div className="col grow" style={{ minWidth: 0, lineHeight: 1.3 }}>
              <span style={{ fontSize: 12 }}>{f.txt}</span>
              <span className="row gap6" style={{ fontSize: 10, color: "var(--ink-4)", marginTop: 1 }}>
                <span className="mono">{f.proj}</span>·<span className="mono">{f.model}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Dashboard({ layout, onOpenProject }) {
  const P = window.NS.projects;
  const totalAgents = P.reduce((a, p) => a + p.agentsActive, 0);
  const blocked = P.filter(p => p.status === "blocked" || p.status === "needs-input").length;
  const commits = P.reduce((a, p) => a + p.commits24, 0);

  return (
    <div className="screen">
      <div className="dash-stats">
        <StatTile label="AGENTS IN FLIGHT" value={totalAgents} accent="var(--star)" icon="bolt"
                  sub="across 4 active projects" spark={[4,5,6,5,7,6,8,8]}/>
        <StatTile label="TOKENS · TODAY" value="1.32M" icon="layers"
                  sub="of 4M daily ceiling · 33%" spark={[2,3,3,4,5,5,6,7]}/>
        <StatTile label="COMMITS · 24H" value={commits} accent="var(--ok)" icon="branch"
                  sub="+3,252 / −1,236 net lines" spark={[3,4,3,5,6,5,7,8]}/>
        <StatTile label="NEEDS YOU" value={blocked} accent="var(--cyan)" icon="alert"
                  sub="2 clarifications · 1 blocked build"/>
      </div>

      <div className="dash-body">
        <div className="dash-main scroll">
          <div className="row gap10" style={{ marginBottom: 10 }}>
            <span className="eyebrow">PROJECTS</span>
            <span className="tnum" style={{ fontSize: 11, color: "var(--ink-4)" }}>{P.length} tracked · ~/dev</span>
            <span className="grow"></span>
            <button className="btn btn-sm"><DIcon name="filter" size={12}/> Filter</button>
            <button className="btn btn-sm"><DIcon name="plus" size={12}/> Add project</button>
          </div>

          {layout === "list" ? (
            <div className="panel brackets" style={{ overflow: "hidden" }}>
              <div className="proj-row head">
                <span style={{ width: 26 }}></span>
                <span className="eyebrow" style={{ width: 130 }}>PROJECT</span>
                <span className="eyebrow" style={{ width: 92 }}>STATUS</span>
                <span className="eyebrow" style={{ width: 150 }}>BRANCH</span>
                <span className="eyebrow" style={{ width: 60 }}>LANG</span>
                <span className="eyebrow" style={{ width: 110 }}>24H</span>
                <span className="eyebrow" style={{ width: 56, textAlign: "right" }}>COV</span>
                <span className="eyebrow" style={{ width: 64, textAlign: "right" }}>NODES</span>
                <span className="grow"></span>
                <span className="eyebrow">LATEST</span>
              </div>
              {P.map(p => <ProjectRow key={p.id} p={p} onOpen={onOpenProject}/>)}
            </div>
          ) : layout === "mosaic" ? (
            <div className="dash-mosaic">
              {P.map((p, i) => (
                <div key={p.id} className={"mos-cell mos-" + (i === 0 ? "hero" : (p.status === "blocked" || p.status === "needs-input") ? "tall" : "")}>
                  <ProjectCard p={p} onOpen={onOpenProject}/>
                </div>
              ))}
            </div>
          ) : (
            <div className="dash-cards">
              {P.map(p => <ProjectCard key={p.id} p={p} onOpen={onOpenProject}/>)}
            </div>
          )}
        </div>

        <div className="dash-side">
          <ActivityFeed/>
        </div>
      </div>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS.Dashboard = Dashboard;
