/* ============================================================
   NORTHSTAR — Agent Queue + Clarifying Inbox
   ============================================================ */
const { Icon: QIcon, StatusTag: QStatus, ModelChip: QModel, pct: Qpct } = window.UI;

const PRIO_COLOR = { P0: "var(--err)", P1: "var(--star)", P2: "var(--cyan)", P3: "var(--ink-3)" };
const projName = (id) => (window.NS.projects.find(p => p.id === id) || {}).name || id;

function QueueItem({ q, active, onClick, onReview, paused, onPause }) {
  const isRun = q.status === "running";
  const isBlock = q.status === "blocked" || q.status === "needs-input";
  return (
    <div className={"q-item" + (active ? " active" : "")} onClick={() => onClick(q)}>
      <div className="q-prio" style={{ background: PRIO_COLOR[q.priority] }} title={q.priority}></div>
      <div className="col grow" style={{ minWidth: 0, gap: 7 }}>
        <div className="row gap10" style={{ minWidth: 0 }}>
          <span className="mono q-id">{q.id}</span>
          <span className="q-title grow">{q.title}</span>
          <QStatus status={q.status}/>
        </div>
        <div className="row gap10" style={{ minWidth: 0, flexWrap: "wrap" }}>
          <span className="row gap4 q-tag"><i className="dot dot-run" style={{ background: "var(--ink-3)" }}></i>{projName(q.project)}</span>
          <QModel id={q.model} small/>
          <span className="q-tag mono">{q.agent}</span>
          {q.files > 0 && <span className="q-tag mono"><QIcon name="review" size={11}/> {q.files} files</span>}
          {q.branch !== "—" && <span className="q-tag mono"><QIcon name="branch" size={11}/> {q.branch}</span>}
          <span className="grow"></span>
          <span className="mono" style={{ fontSize: 11, color: isBlock ? "var(--err)" : "var(--ink-3)", whiteSpace: "nowrap" }}>{q.stage}</span>
        </div>
        {/* progress */}
        <div className="row gap8" style={{ marginTop: 1 }}>
          <div className="meter grow" style={{ height: 4 }}>
            <i style={{ width: Qpct(q.progress), background: isBlock ? "var(--err)" : isRun ? "var(--star)" : "var(--idle)" }}></i>
          </div>
          <span className="tnum" style={{ fontSize: 10.5, color: "var(--ink-3)", width: 56, textAlign: "right" }}>
            {q.status === "queued" || q.status === "done" ? "" : Qpct(q.progress)}
          </span>
          <span className="tnum" style={{ fontSize: 10.5, color: "var(--ink-4)", width: 42, textAlign: "right" }}>{q.eta}</span>
        </div>
      </div>
      {/* hover actions */}
      <div className="q-actions">
        {(q.status === "running" || q.status === "needs-input") && q.files > 0 &&
          <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onReview(); }}><QIcon name="review" size={12}/> Review</button>}
        {isRun && <button className="btn btn-sm btn-ghost" title={paused ? "Resume" : "Pause"} onClick={(e) => { e.stopPropagation(); onPause(q.id); }}>
          <QIcon name={paused ? "play" : "pause"} size={12}/></button>}
      </div>
    </div>
  );
}

function InboxCard({ item, onAnswer }) {
  const [picked, setPicked] = useState(null);
  return (
    <div className={"inbox-card" + (picked !== null ? " answered" : "")}>
      <div className="row gap8" style={{ justifyContent: "space-between" }}>
        <div className="row gap8">
          <span className={"u-dot u-" + item.urgency}></span>
          <span className="mono" style={{ fontSize: 11, color: "var(--ink)" }}>{projName(item.project)}</span>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{item.task}</span>
        </div>
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-4)" }}>{item.ago}</span>
      </div>
      <p className="inbox-q">{item.q}</p>
      <p className="inbox-ctx"><QIcon name="graph" size={12} style={{ color: "var(--ink-4)", verticalAlign: "-2px" }}/> {item.ctx}</p>
      <div className="inbox-opts">
        {item.options.map((o, i) => (
          <button key={i} className={"inbox-opt" + (picked === i ? " on" : "")}
            disabled={picked !== null}
            onClick={() => { setPicked(i); setTimeout(() => onAnswer(item.id, o), 550); }}>
            {picked === i && <QIcon name="check" size={13}/>}
            {o}
          </button>
        ))}
      </div>
      <div className="row gap8" style={{ marginTop: 2 }}>
        <QModel id={item.model} small/>
        <span className="grow"></span>
        <button className="btn btn-sm btn-ghost"><QIcon name="graph" size={12}/> Open in graph</button>
      </div>
    </div>
  );
}

const FILTERS = ["all", "running", "needs-input", "queued", "blocked", "done"];

function Queue({ onReview, onGraph }) {
  const [filter, setFilter] = useState("all");
  const [active, setActive] = useState(null);
  const [paused, setPaused] = useState({});
  const [inbox, setInbox] = useState(window.NS.inbox);
  const [answered, setAnswered] = useState([]);

  const items = window.NS.queue.filter(q => filter === "all" ? true : q.status === filter);
  const counts = FILTERS.reduce((a, f) => (a[f] = f === "all" ? window.NS.queue.length : window.NS.queue.filter(q => q.status === f).length, a), {});
  const nextUp = window.NS.queue.find(q => q.status === "needs-input") || window.NS.queue.find(q => q.status === "blocked");

  const answer = (id, choice) => {
    setInbox(prev => prev.filter(x => x.id !== id));
    setAnswered(a => [...a, { id, choice }]);
  };

  return (
    <div className="screen queue-screen">
      <div className="queue-grid">
        {/* left: queue */}
        <div className="col" style={{ minHeight: 0, gap: 12 }}>
          {/* recommended next */}
          {nextUp && (
            <div className="panel brackets next-up">
              <div className="row gap8" style={{ marginBottom: 7 }}>
                <QIcon name="star" size={14} style={{ color: "var(--star)" }}/>
                <span className="eyebrow" style={{ color: "var(--star)" }}>WHAT TO WORK ON NEXT</span>
              </div>
              <div className="row gap12" style={{ minWidth: 0 }}>
                <div className="col grow" style={{ minWidth: 0, gap: 3 }}>
                  <div className="row gap8"><span className="mono q-id">{nextUp.id}</span><span className="q-title">{nextUp.title}</span></div>
                  <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {projName(nextUp.project)} · {nextUp.status === "needs-input" ? "agent is waiting on your answer" : "build is red and blocking the queue"}
                  </span>
                </div>
                <button className="btn btn-primary" onClick={() => { document.getElementById("inbox-scroll")?.scrollTo({ top: 0 }); }}>
                  <QIcon name="arrowR" size={14}/> Resolve
                </button>
              </div>
            </div>
          )}

          {/* filters */}
          <div className="row gap6 q-filters">
            {FILTERS.map(f => (
              <button key={f} className={"chip" + (filter === f ? " on" : "")} onClick={() => setFilter(f)}>
                {f.replace("-", " ")}<span className="chip-n">{counts[f]}</span>
              </button>
            ))}
            <span className="grow"></span>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>4 / 6 slots · 2 local</span>
          </div>

          {/* queue list */}
          <div className="panel brackets grow" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div className="panel-hd"><QIcon name="queue" size={14}/><h3>Execution Queue</h3>
              <span className="grow"></span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{items.length} tasks</span>
            </div>
            <div className="scroll grow">
              {items.map(q => (
                <QueueItem key={q.id} q={q} active={active === q.id}
                  paused={!!paused[q.id]}
                  onClick={(x) => setActive(x.id)}
                  onReview={onReview}
                  onPause={(id) => setPaused(p => ({ ...p, [id]: !p[id] }))}/>
              ))}
            </div>
          </div>
        </div>

        {/* right: clarifying inbox */}
        <div className="panel brackets col" style={{ minHeight: 0, overflow: "hidden" }}>
          <div className="panel-hd">
            <QIcon name="alert" size={14} style={{ color: "var(--cyan)" }}/>
            <h3>Clarifying Inbox</h3>
            <span className="grow"></span>
            <span className="tag" style={{ color: inbox.length ? "var(--cyan)" : "var(--ink-3)", borderColor: "var(--line)" }}>{inbox.length} OPEN</span>
          </div>
          <div id="inbox-scroll" className="scroll grow" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
            {inbox.length === 0
              ? <div className="inbox-empty"><QIcon name="check" size={22} style={{ color: "var(--ok)" }}/><span>Inbox zero. Agents are unblocked.</span></div>
              : inbox.map(it => <InboxCard key={it.id} item={it} onAnswer={answer}/>)}
            {answered.map((a, i) => (
              <div key={i} className="answered-log">
                <QIcon name="check" size={12} style={{ color: "var(--ok)" }}/>
                <span className="mono">{a.id}</span> answered — agent resumed: <span style={{ color: "var(--ink-2)" }}>“{a.choice}”</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS.Queue = Queue;
