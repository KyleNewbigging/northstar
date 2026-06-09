/* ============================================================
   NORTHSTAR — shell: Rail, HUD, CommandBar  (window.SHELL)
   ============================================================ */
const { Icon: SIcon, ModelChip } = window.UI;

/* ---------------- left nav rail ---------------- */
function Rail({ view, setView }) {
  const items = [
    { id: "dashboard", icon: "dash",   label: "Dashboard" },
    { id: "inbox",     icon: "inbox",  label: "Inbox" },
    { id: "queue",     icon: "queue",  label: "Agent Queue" },
    { id: "graph",     icon: "graph",  label: "Graph Cockpit" },
    { id: "review",    icon: "review", label: "Patch Review" },
  ];
  return (
    <nav className="rail">
      <div className="rail-logo" title="Northstar">
        <SIcon name="star" size={20} style={{ color: "var(--star)" }}/>
      </div>
      <div className="rail-nav">
        {items.map(it => (
          <button key={it.id}
            className={"rail-btn" + (view === it.id ? " on" : "")}
            onClick={() => setView(it.id)} title={it.label}>
            <SIcon name={it.icon} size={18}/>
            {it.id === "inbox" && <span className="rail-badge">8</span>}
            <span className="rail-tip">{it.label}</span>
          </button>
        ))}
      </div>
      <button className="rail-btn" title="Settings" style={{ marginTop: "auto" }}>
        <SIcon name="settings" size={18}/>
        <span className="rail-tip">Settings</span>
      </button>
    </nav>
  );
}

/* ---------------- top HUD bar ---------------- */
function UsageMeter({ label, used, total, unit, cool }) {
  const r = Math.min(1, used / total);
  const hot = r > 0.85;
  return (
    <div className="usage" title={`${label}: ${used}/${total} ${unit}`}>
      <div className="row gap6" style={{ justifyContent: "space-between" }}>
        <span className="eyebrow" style={{ fontSize: 9 }}>{label}</span>
        <span className="tnum" style={{ fontSize: 10, color: hot ? "var(--err)" : "var(--ink-2)" }}>
          {window.UI.pct(r)}
        </span>
      </div>
      <div className={"meter" + (cool ? " cool" : "")} style={{ width: 96, marginTop: 4 }}>
        <i style={{ width: window.UI.pct(r), background: hot ? "var(--err)" : undefined }}></i>
      </div>
    </div>
  );
}

function HUD({ view }) {
  const titles = {
    dashboard: ["FLIGHT DECK", "6 projects · 8 agents in flight"],
    inbox: ["MISSION INBOX", "what needs you — across all projects"],
    queue: ["AGENT QUEUE", "what to work on next"],
    graph: ["GRAPH COCKPIT", "atlas-api · knowledge graph"],
    review: ["PATCH REVIEW", "T-1042 · agent/rate-limiter"],
  };
  const [t1, t2] = titles[view] || titles.dashboard;
  const [clock, setClock] = useState("");
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString("en-GB"));
    tick(); const i = setInterval(tick, 1000); return () => clearInterval(i);
  }, []);
  return (
    <header className="hud">
      <div className="row gap10" style={{ minWidth: 0 }}>
        <span className="eyebrow" style={{ color: "var(--star)" }}>NORTHSTAR</span>
        <span style={{ color: "var(--line)" }}>/</span>
        <div className="col" style={{ lineHeight: 1.15, whiteSpace: "nowrap" }}>
          <span className="mono" style={{ fontSize: 12, fontWeight: 500, letterSpacing: ".06em" }}>{t1}</span>
          <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{t2}</span>
        </div>
      </div>

      <div className="row gap16">
        <UsageMeter label="TOKENS / DAY" used={1.32} total={4} unit="M"/>
        <UsageMeter label="COMPUTE" used={61} total={100} unit="%" cool/>
        <div className="usage" title="Local provider — Spark">
          <span className="eyebrow" style={{ fontSize: 9 }}>LOCAL · SPARK</span>
          <div className="row gap6" style={{ marginTop: 4 }}>
            <i className="dot dot-run live"></i>
            <span className="tnum" style={{ fontSize: 10, color: "var(--ink-2)" }}>3 slots free</span>
          </div>
        </div>
        <div className="divider" style={{ width: 1, height: 26, background: "var(--line)" }}></div>
        <div className="row gap6" title="agents in flight">
          <SIcon name="bolt" size={14} style={{ color: "var(--star)" }}/>
          <span className="tnum" style={{ fontSize: 13, fontWeight: 500 }}>8</span>
        </div>
        <span className="tnum" style={{ fontSize: 11, color: "var(--ink-3)" }}>{clock}</span>
      </div>
    </header>
  );
}

/* ---------------- bottom command bar ---------------- */
function CommandBar({ onSend, model, setModel }) {
  const [val, setVal] = useState("");
  const [rec, setRec] = useState(false);
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState("atlas-api");
  const models = window.NS.MODELS;
  const ref = useRef(null);

  useEffect(() => {
    if (!rec) return;
    const i = setTimeout(() => setRec(false), 4200); return () => clearTimeout(i);
  }, [rec]);

  const submit = () => {
    if (!val.trim()) return;
    onSend && onSend(val, model, ctx);
    setVal("");
  };

  return (
    <div className="cmdbar">
      <div className={"cmd-shell" + (rec ? " rec" : "")}>
        {/* mic */}
        <button className={"cmd-mic" + (rec ? " on" : "")} onClick={() => setRec(r => !r)}
                title="Hold to talk">
          <SIcon name="mic" size={17}/>
          {rec && <span className="mic-rings"><i></i><i></i><i></i></span>}
        </button>

        {/* context chip */}
        <button className="cmd-ctx" title="Scope to project">
          <i className="dot dot-run"></i>
          <span className="mono">{ctx}</span>
          <SIcon name="chevD" size={12} style={{ color: "var(--ink-3)" }}/>
        </button>

        {/* input */}
        <input ref={ref} className="cmd-input" value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
          placeholder={rec ? "Listening…" : "Direct an agent — “refactor the auth guards and open a PR”"} />

        {/* model selector */}
        <div className="cmd-model" style={{ position: "relative" }}>
          <button className="model-btn" onClick={() => setOpen(o => !o)}>
            <i className="dot" style={{ background: window.UI.MODEL_COLOR[model] }}></i>
            <span className="mono">{models.find(m => m.id === model)?.label}</span>
            <SIcon name="chevD" size={12} style={{ color: "var(--ink-3)" }}/>
          </button>
          {open && (
            <div className="model-menu fade-in">
              <div className="eyebrow" style={{ padding: "8px 10px 4px" }}>SELECT MODEL</div>
              {models.map(m => (
                <button key={m.id} className={"model-opt" + (m.id === model ? " on" : "")}
                  onClick={() => { setModel(m.id); setOpen(false); }}>
                  <i className="dot" style={{ background: window.UI.MODEL_COLOR[m.id] }}></i>
                  <div className="col grow" style={{ alignItems: "flex-start", lineHeight: 1.25 }}>
                    <span className="mono" style={{ fontSize: 12 }}>{m.label}</span>
                    <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
                      {m.vendor} · {m.tier}{m.local ? " · on-device" : ""}
                    </span>
                  </div>
                  {m.id === model && <SIcon name="check" size={14} style={{ color: "var(--star)" }}/>}
                </button>
              ))}
            </div>
          )}
        </div>

        <button className="btn btn-primary" onClick={submit} style={{ height: 38 }}>
          <SIcon name="arrowR" size={15}/> Dispatch
        </button>
      </div>
      <div className="cmd-hint">
        <span><span className="kbd">⌘K</span> command palette</span>
        <span><span className="kbd">⌘↵</span> dispatch to all selected</span>
        <span><span className="kbd">/</span> agents · <span className="kbd">@</span> files · <span className="kbd">#</span> tasks</span>
      </div>
    </div>
  );
}

window.SHELL = { Rail, HUD, CommandBar };
