/* ============================================================
   NORTHSTAR — Graph Cockpit (graphify-style knowledge graph)
   ============================================================ */
const { Icon: GIcon, ModelChip: GModel } = window.UI;

const FIELD_W = 1000, FIELD_H = 680;

/* ---- layout solvers ---- */
function useLayout(layout) {
  return useMemo(() => {
    const N = window.NS.gnodes, E = window.NS.gedges, COMMS = window.NS.COMMS;
    const pos = {};
    if (layout === "constellation") {
      N.forEach(n => pos[n.id] = { x: n.x, y: n.y });
    } else if (layout === "swimlane") {
      const laneH = FIELD_H / COMMS.length;
      COMMS.forEach((c, li) => {
        const inLane = N.filter(n => n.c === c.id).sort((a, b) => b.deg - a.deg);
        const cy = laneH * li + laneH / 2;
        inLane.forEach((n, i) => {
          const span = 760, x0 = 170;
          const x = inLane.length === 1 ? x0 + span / 2 : x0 + (span * i) / (inLane.length - 1);
          pos[n.id] = { x, y: cy + (i % 2 ? 14 : -14) };
        });
      });
    } else { /* dag — BFS depth from Server */
      const adj = {}; N.forEach(n => adj[n.id] = []);
      E.forEach(([a, b]) => { adj[a].push(b); adj[b].push(a); });
      const depth = { Server: 0 }; const q = ["Server"];
      while (q.length) { const u = q.shift(); adj[u].forEach(v => { if (depth[v] === undefined) { depth[v] = depth[u] + 1; q.push(v); } }); }
      N.forEach(n => { if (depth[n.id] === undefined) depth[n.id] = 4; });
      const maxD = Math.max(...Object.values(depth));
      const byD = {}; N.forEach(n => { (byD[depth[n.id]] = byD[depth[n.id]] || []).push(n); });
      Object.keys(byD).forEach(d => {
        const col = byD[d].sort((a, b) => a.c - b.c);
        const x = 110 + (Number(d) / maxD) * 800;
        col.forEach((n, i) => {
          const y = col.length === 1 ? FIELD_H / 2 : 70 + (540 * i) / (col.length - 1);
          pos[n.id] = { x, y };
        });
      });
    }
    return pos;
  }, [layout]);
}

const nodeR = (n) => (n.kind === "god" ? 11 : n.kind === "file" ? 7 : 5.5) + Math.min(8, n.deg * 0.45);
const EDGE_STYLE = {
  ext: { dash: "none", op: 0.5 },
  inf: { dash: "4 4", op: 0.34 },
  amb: { dash: "1.5 5", op: 0.24 },
};
const commColor = (id) => (window.NS.COMMS.find(c => c.id === id) || {}).color;

function GraphCanvas({ pos, selected, setSelected, hidden, agentFocus, onReview }) {
  const N = window.NS.gnodes, E = window.NS.gedges;
  const [vt, setVt] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef(null);
  const [hover, setHover] = useState(null);

  const neighbors = useMemo(() => {
    const m = {}; N.forEach(n => m[n.id] = new Set());
    E.forEach(([a, b]) => { m[a].add(b); m[b].add(a); });
    return m;
  }, []);

  const focusId = selected || hover;
  const lit = (id) => !focusId || id === focusId || neighbors[focusId].has(id);

  const onWheel = (e) => {
    e.preventDefault();
    const k = Math.min(2.6, Math.max(0.6, vt.k * (e.deltaY < 0 ? 1.12 : 0.9)));
    setVt(v => ({ ...v, k }));
  };
  const onDown = (e) => { drag.current = { x: e.clientX, y: e.clientY, vx: vt.x, vy: vt.y }; };
  const onMove = (e) => {
    if (!drag.current) return;
    setVt(v => ({ ...v, x: drag.current.vx + (e.clientX - drag.current.x), y: drag.current.vy + (e.clientY - drag.current.y) }));
  };
  const onUp = () => { drag.current = null; };

  return (
    <svg className="graph-svg" viewBox={`0 0 ${FIELD_W} ${FIELD_H}`} preserveAspectRatio="xMidYMid meet"
      onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
      onClick={(e) => { if (e.target.tagName === "svg" || e.target.classList.contains("g-bg")) setSelected(null); }}>
      <rect className="g-bg" x="-2000" y="-2000" width="6000" height="6000" fill="transparent"/>
      <g transform={`translate(${vt.x} ${vt.y}) scale(${vt.k})`}>
        {/* edges */}
        {E.map(([a, b, conf], i) => {
          if (hidden.has(N.find(n => n.id === a).c) || hidden.has(N.find(n => n.id === b).c)) return null;
          const pa = pos[a], pb = pos[b]; if (!pa || !pb) return null;
          const st = EDGE_STYLE[conf];
          const on = lit(a) && lit(b) && (!focusId || a === focusId || b === focusId);
          const na = N.find(n => n.id === a), nb = N.find(n => n.id === b);
          const flow = agentFocus && (na.agent && nb.agent);
          return (
            <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
              stroke={on ? "var(--star)" : "var(--ink-3)"}
              strokeWidth={on ? 1.4 : 1}
              strokeDasharray={flow ? "5 5" : st.dash}
              className={flow ? "g-flow" : ""}
              opacity={focusId ? (on ? 0.85 : 0.06) : st.op}/>
          );
        })}
        {/* nodes */}
        {N.map(n => {
          if (hidden.has(n.c)) return null;
          const p = pos[n.id]; if (!p) return null;
          const r = nodeR(n);
          const on = lit(n.id);
          const sel = selected === n.id;
          const showLabel = n.kind === "god" || sel || hover === n.id;
          return (
            <g key={n.id} transform={`translate(${p.x} ${p.y})`}
              className="g-node" opacity={on ? 1 : 0.18}
              onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
              onClick={(e) => { e.stopPropagation(); setSelected(n.id); }}>
              {n.agent && agentFocus && <circle r={r + 8} className={"g-agent" + (n.hot ? " hot" : "")} fill="none"/>}
              {sel && <circle r={r + 6} fill="none" stroke="var(--star)" strokeWidth="1.5" opacity="0.9"/>}
              <circle r={r} fill={commColor(n.c)} stroke="var(--bg)" strokeWidth="1.5"
                style={{ filter: n.kind === "god" ? "saturate(1.1)" : "none" }}/>
              {n.agent && agentFocus && <circle r={r * 0.4} fill="var(--star)"/>}
              {showLabel && (
                <text y={r + 13} textAnchor="middle" className="g-label"
                  style={{ fill: sel ? "var(--star)" : "var(--ink-2)" }}>{n.id}</text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function Inspector({ id, onReview, onClose }) {
  const n = window.NS.gnodes.find(x => x.id === id);
  if (!n) return null;
  const comm = window.NS.COMMS.find(c => c.id === n.c);
  const nb = window.NS.gedges.filter(([a, b]) => a === id || b === id).map(([a, b, c]) => ({ id: a === id ? b : a, conf: c }));
  const kindLabel = { god: "hub · god-node", file: "module", fn: "function" }[n.kind];
  return (
    <div className="g-inspector fade-in">
      <div className="row gap8" style={{ justifyContent: "space-between", marginBottom: 2 }}>
        <span className="eyebrow">NODE INSPECTOR</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose}><GIcon name="x" size={13}/></button>
      </div>
      <div className="row gap8" style={{ marginTop: 6 }}>
        <span className="g-swatch" style={{ background: comm.color }}></span>
        <span className="mono" style={{ fontSize: 15, color: "var(--ink)" }}>{n.id}</span>
      </div>
      <div className="row gap6" style={{ marginTop: 4, flexWrap: "wrap" }}>
        <span className="tag">{kindLabel}</span>
        <span className="tag" style={{ color: comm.color, borderColor: comm.color }}>{comm.name}</span>
        <span className="tag mono">deg {n.deg}</span>
      </div>

      {n.agent && (
        <div className="g-agentbox">
          <div className="row gap6"><i className="dot dot-run live"></i><span className="eyebrow" style={{ color: "var(--star)" }}>AGENT ACTIVE</span></div>
          <p style={{ fontSize: 12, color: "var(--ink-2)", margin: "6px 0 8px", lineHeight: 1.4 }}>
            {n.hot ? "Opus is editing this hub — task T-1042 replaces the fixed window with a sliding-window log." : "Spark drafted edits here as part of the auth-guard refactor."}
          </p>
          {n.hot && <button className="btn btn-primary btn-sm" onClick={onReview}><GIcon name="review" size={12}/> Review patch · T-1042</button>}
        </div>
      )}

      <div className="g-path mono">src/{comm.name.split("/")[0]}/{n.id.replace(/[().]/g, "")}.ts</div>

      <div className="eyebrow" style={{ margin: "12px 0 6px" }}>CONNECTIONS · {nb.length}</div>
      <div className="col" style={{ gap: 4 }}>
        {nb.map((x, i) => {
          const tn = window.NS.gnodes.find(g => g.id === x.id);
          return (
            <div key={i} className="g-nb">
              <span className="g-swatch sm" style={{ background: commColor(tn.c) }}></span>
              <span className="mono grow">{x.id}</span>
              <span className="mono" style={{ fontSize: 9.5, color: "var(--ink-4)" }}>{x.conf.toUpperCase()}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Graph({ layout, onReview }) {
  const pos = useLayout(layout);
  const [selected, setSelected] = useState("RateLimiter");
  const [hidden, setHidden] = useState(new Set());
  const [agentFocus, setAgentFocus] = useState(true);
  const [query, setQuery] = useState("");
  const COMMS = window.NS.COMMS, N = window.NS.gnodes;

  const toggleComm = (id) => setHidden(h => { const n = new Set(h); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const results = query ? N.filter(n => n.id.toLowerCase().includes(query.toLowerCase())) : [];

  return (
    <div className="screen graph-screen" style={{ padding: 0 }}>
      <div className="graph-wrap">
        {/* canvas */}
        <GraphCanvas pos={pos} selected={selected} setSelected={setSelected}
          hidden={hidden} agentFocus={agentFocus} onReview={onReview}/>

        {/* top toolbar overlay */}
        <div className="graph-toolbar">
          <div className="g-search">
            <GIcon name="search" size={14} style={{ color: "var(--ink-3)" }}/>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="query nodes — “rate”, “auth”…"/>
            {results.length > 0 && (
              <div className="g-results">
                {results.map(r => (
                  <button key={r.id} className="g-result" onClick={() => { setSelected(r.id); setQuery(""); }}>
                    <span className="g-swatch sm" style={{ background: commColor(r.c) }}></span>
                    <span className="mono">{r.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className={"chip" + (agentFocus ? " on" : "")} onClick={() => setAgentFocus(a => !a)}>
            <GIcon name="bolt" size={12}/> agent activity
          </button>
          <span className="grow"></span>
          <div className="g-stats">
            <span><b className="tnum">{N.length}</b> nodes</span>
            <span><b className="tnum">{window.NS.gedges.length}</b> edges</span>
            <span><b className="tnum">{COMMS.length}</b> communities</span>
          </div>
        </div>

        {/* community legend (bottom-left) */}
        <div className="graph-legend">
          <span className="eyebrow" style={{ marginBottom: 2 }}>COMMUNITIES</span>
          {COMMS.map(c => (
            <button key={c.id} className={"legend-row" + (hidden.has(c.id) ? " off" : "")} onClick={() => toggleComm(c.id)}>
              <span className="g-swatch sm" style={{ background: c.color }}></span>
              <span className="mono grow">{c.name}</span>
              <span className="tnum" style={{ color: "var(--ink-4)" }}>{N.filter(n => n.c === c.id).length}</span>
            </button>
          ))}
          <div className="legend-conf">
            <span><span className="cline ext"></span>extracted</span>
            <span><span className="cline inf"></span>inferred</span>
            <span><span className="cline amb"></span>ambiguous</span>
          </div>
        </div>

        {/* hint */}
        <div className="graph-hint mono">scroll to zoom · drag to pan · click a node</div>

        {/* inspector */}
        {selected && <Inspector id={selected} onReview={onReview} onClose={() => setSelected(null)}/>}
      </div>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS.Graph = Graph;
