/* ============================================================
   NORTHSTAR — Patch / Worktree Review
   ============================================================ */
const { Icon: RIcon, ModelChip: RModel } = window.UI;

const FILE_STATUS = { new: { c: "var(--ok)", l: "NEW" }, mod: { c: "var(--star)", l: "MOD" }, "del-partial": { c: "var(--err)", l: "DEL" } };
const CHECK_STATE = { pass: { c: "var(--ok)", i: "check" }, running: { c: "var(--star)", i: "clock" }, fail: { c: "var(--err)", i: "x" } };

function Checks({ checks }) {
  return (
    <div className="row gap8" style={{ flexWrap: "wrap" }}>
      {checks.map((c, i) => {
        const st = CHECK_STATE[c.state];
        return (
          <div key={i} className="check-pill">
            <RIcon name={st.i} size={12} style={{ color: st.c }} className={c.state === "running" ? "live" : ""}/>
            <span className="mono">{c.name}</span>
            {c.detail && <span className="mono" style={{ color: "var(--ink-4)" }}>{c.detail}</span>}
            {c.ms > 0 && <span className="mono" style={{ color: "var(--ink-4)" }}>{(c.ms / 1000).toFixed(1)}s</span>}
          </div>
        );
      })}
    </div>
  );
}

function FileRow({ f, active, onClick }) {
  const st = FILE_STATUS[f.status];
  return (
    <button className={"file-row" + (active ? " active" : "")} onClick={() => onClick(f)}>
      <span className="file-badge" style={{ color: st.c, borderColor: st.c }}>{st.l}</span>
      <span className="mono file-path grow">{f.path}</span>
      <span className="mono" style={{ fontSize: 10.5, color: "var(--ok)" }}>+{f.add}</span>
      <span className="mono" style={{ fontSize: 10.5, color: "var(--err)" }}>−{f.del}</span>
    </button>
  );
}

function DiffUnified({ lines }) {
  return (
    <div className="diff-unified">
      {lines.map((l, i) => {
        if (l.t === "hunk") return <div key={i} className="diff-hunk mono">@@ {l.s} @@</div>;
        return (
          <div key={i} className={"dline " + l.t}>
            <span className="gut">{l.n1 || ""}</span>
            <span className="gut">{l.n2 || ""}</span>
            <span className="sign">{l.t === "add" ? "+" : l.t === "del" ? "−" : " "}</span>
            <code>{l.s || "\u00A0"}</code>
          </div>
        );
      })}
    </div>
  );
}

function toSplit(lines) {
  const rows = []; let dels = [], adds = [];
  const flush = () => { const m = Math.max(dels.length, adds.length); for (let k = 0; k < m; k++) rows.push({ type: "change", left: dels[k] || null, right: adds[k] || null }); dels = []; adds = []; };
  for (const l of lines) {
    if (l.t === "hunk") { flush(); rows.push({ hunk: l.s }); }
    else if (l.t === "ctx") { flush(); rows.push({ type: "ctx", left: { n: l.n1, s: l.s }, right: { n: l.n2, s: l.s } }); }
    else if (l.t === "del") dels.push({ n: l.n1, s: l.s });
    else if (l.t === "add") adds.push({ n: l.n2, s: l.s });
  }
  flush(); return rows;
}

function DiffSplit({ lines }) {
  const rows = toSplit(lines);
  return (
    <div className="diff-split">
      {rows.map((r, i) => {
        if (r.hunk) return <div key={i} className="diff-hunk mono span2">@@ {r.hunk} @@</div>;
        return (
          <React.Fragment key={i}>
            <div className={"dcell " + (r.type === "ctx" ? "ctx" : r.left ? "del" : "empty")}>
              <span className="gut">{r.left ? r.left.n : ""}</span>
              <code>{r.left ? (r.left.s || "\u00A0") : ""}</code>
            </div>
            <div className={"dcell " + (r.type === "ctx" ? "ctx" : r.right ? "add" : "empty")}>
              <span className="gut">{r.right ? r.right.n : ""}</span>
              <code>{r.right ? (r.right.s || "\u00A0") : ""}</code>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function Rationale({ patch }) {
  return (
    <div className="panel brackets col" style={{ overflow: "hidden" }}>
      <div className="panel-hd"><RIcon name="star" size={13} style={{ color: "var(--star)" }}/><h3>Agent Rationale</h3>
        <span className="grow"></span><RModel id={patch.model} small/></div>
      <div className="scroll grow" style={{ padding: 13 }}>
        <p className="rat-summary">{patch.summary}</p>

        <div className="eyebrow" style={{ margin: "14px 0 7px" }}>WHY</div>
        <ol className="rat-list">
          {patch.rationale.map((r, i) => <li key={i}>{r}</li>)}
        </ol>

        <div className="eyebrow" style={{ margin: "16px 0 7px" }}>RISK ASSESSMENT</div>
        <div className="col gap8">
          {patch.risks.map((r, i) => (
            <div key={i} className="risk-row">
              <span className={"risk-badge r-" + r.level}>{r.level}</span>
              <span style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.4 }}>{r.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Review({ layout, onBack }) {
  const patch = window.NS.patch;
  const [active, setActive] = useState(patch.files[1].path); // RateLimiter.ts (has diff)
  const [verdict, setVerdict] = useState(null);
  const activeFile = patch.files.find(f => f.path === active);
  const hasDiff = active === "src/ratelimit/RateLimiter.ts";

  const DiffView = ({ lines }) => layout === "split" ? <DiffSplit lines={lines}/> : <DiffUnified lines={lines}/>;

  return (
    <div className="screen review-screen">
      {/* header */}
      <div className="rv-head">
        <button className="btn btn-ghost btn-sm" onClick={onBack}><RIcon name="chevR" size={13} style={{ transform: "rotate(180deg)" }}/> Queue</button>
        <div className="col rv-headcol" style={{ minWidth: 0, lineHeight: 1.3 }}>
          <div className="row gap8" style={{ minWidth: 0 }}><span className="mono q-id">{patch.task}</span><span className="rv-title grow">{patch.title}</span></div>
          <div className="row gap8" style={{ fontSize: 11, color: "var(--ink-3)" }}>
            <span className="mono">{window.NS.projects.find(p => p.id === patch.project).name}</span>
            <span className="row gap4 mono"><RIcon name="branch" size={11}/>{patch.branch} → {patch.base}</span>
            <span className="mono" style={{ color: "var(--ink-4)" }}>{patch.worktree}</span>
          </div>
        </div>
        <span className="grow"></span>
        <RModel id={patch.model}/>
        <div className="row gap6">
          <button className={"btn btn-sm" + (verdict === "changes" ? " btn-danger" : "")} onClick={() => setVerdict("changes")}>
            <RIcon name="x" size={13}/> Request changes
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setVerdict("merge")}>
            <RIcon name="branch" size={13}/> Approve & merge worktree
          </button>
        </div>
      </div>

      {verdict && (
        <div className={"rv-verdict " + verdict}>
          <RIcon name={verdict === "merge" ? "check" : "alert"} size={14} style={{ color: verdict === "merge" ? "var(--ok)" : "var(--err)" }}/>
          <span className="mono">{verdict === "merge"
            ? `Merging ${patch.branch} → ${patch.base} · worktree will fold back to ${window.NS.projects.find(p=>p.id===patch.project).name}`
            : `Sent back to agent with review notes · worktree kept at ${patch.worktree}`}</span>
        </div>
      )}

      {/* checks + stats */}
      <div className="rv-bar">
        <Checks checks={patch.checks}/>
        <span className="grow"></span>
        <span className="mono rv-stat"><b style={{ color: "var(--ok)" }}>+{patch.additions}</b> / <b style={{ color: "var(--err)" }}>−{patch.deletions}</b></span>
        <span className="mono rv-stat">{patch.filesChanged} files</span>
      </div>

      {/* body */}
      <div className="rv-body">
        {/* files */}
        <div className="panel brackets col" style={{ overflow: "hidden" }}>
          <div className="panel-hd"><RIcon name="layers" size={13}/><h3>Changed Files</h3></div>
          <div className="scroll grow" style={{ padding: 5 }}>
            {patch.files.map(f => <FileRow key={f.path} f={f} active={active === f.path} onClick={(x) => setActive(x.path)}/>)}
          </div>
          <div className="rv-worktree">
            <span className="eyebrow">WORKTREE</span>
            <div className="row gap6" style={{ marginTop: 5 }}><i className="dot dot-run live"></i><span className="mono" style={{ fontSize: 11 }}>isolated · {patch.branch}</span></div>
            <button className="btn btn-sm" style={{ marginTop: 8, width: "100%", justifyContent: "center" }}><RIcon name="branch" size={12}/> Open in editor</button>
          </div>
        </div>

        {/* diff */}
        <div className="panel brackets col" style={{ overflow: "hidden" }}>
          <div className="panel-hd">
            <RIcon name="review" size={13}/>
            <h3 className="mono" style={{ textTransform: "none", letterSpacing: 0 }}>{layout === "stacked" ? "All changes" : active}</h3>
            <span className="grow"></span>
            <span className="tag mono">{layout} diff</span>
          </div>
          <div className="scroll grow diff-scroll">
            {layout === "stacked" ? (
              patch.files.map(f => (
                <div key={f.path} className="stack-file">
                  <div className="stack-head">
                    <span className="file-badge" style={{ color: FILE_STATUS[f.status].c, borderColor: FILE_STATUS[f.status].c }}>{FILE_STATUS[f.status].l}</span>
                    <span className="mono grow">{f.path}</span>
                    <span className="mono" style={{ color: "var(--ok)" }}>+{f.add}</span>
                    <span className="mono" style={{ color: "var(--err)" }}>−{f.del}</span>
                  </div>
                  {f.path === "src/ratelimit/RateLimiter.ts"
                    ? <DiffUnified lines={patch.diff}/>
                    : <div className="diff-collapsed mono">{f.add + f.del} lines changed · expand to view</div>}
                </div>
              ))
            ) : hasDiff ? (
              <DiffView lines={patch.diff}/>
            ) : (
              <div className="diff-collapsed mono" style={{ margin: 16 }}>{activeFile.add + activeFile.del} lines changed in {active} · diff omitted in mock</div>
            )}
          </div>
        </div>

        {/* rationale */}
        <Rationale patch={patch}/>
      </div>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS.Review = Review;
