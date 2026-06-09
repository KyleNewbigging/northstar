/* ============================================================
   NORTHSTAR — Mission Inbox (unified action to-do list)
   ============================================================ */
const { Icon: IIcon, ModelChip: IModel } = window.UI;

const TYPE_META = {
  question: { label: "QUESTION",   icon: "alert",  color: "var(--cyan)" },
  review:   { label: "REVIEW",     icon: "review", color: "var(--star)" },
  blocked:  { label: "BLOCKED",    icon: "alert",  color: "var(--err)" },
  suggest:  { label: "SUGGESTION", icon: "bolt",   color: "var(--c3)" },
};
const PRIO_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const iProj = (id) => window.NS.projects.find(p => p.id === id) || { name: id, label: "work" };

function LabelTag({ label }) {
  return <span className={"lbl lbl-" + label}>{label}</span>;
}

function InboxRow({ it, active, onClick, isNext }) {
  const m = TYPE_META[it.type];
  const p = iProj(it.project);
  return (
    <button className={"ib-row" + (active ? " active" : "")} onClick={() => onClick(it.id)}>
      <span className="ib-prio" style={{ background: PRIO_COLOR_INB[it.priority] }}></span>
      <span className="ib-ticon" style={{ color: m.color }}><IIcon name={m.icon} size={15}/></span>
      <div className="col grow" style={{ minWidth: 0, gap: 3 }}>
        <div className="row gap8" style={{ minWidth: 0 }}>
          {isNext && <span className="ib-next">NEXT</span>}
          <span className="ib-title grow">{it.title}</span>
        </div>
        <div className="row gap8" style={{ minWidth: 0 }}>
          <span className="mono ib-proj">{p.name}</span>
          <LabelTag label={p.label}/>
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-4)" }}>{m.label.toLowerCase()}</span>
          <span className="grow"></span>
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-4)" }}>{it.ago}</span>
        </div>
      </div>
    </button>
  );
}
const PRIO_COLOR_INB = { P0: "var(--err)", P1: "var(--star)", P2: "var(--cyan)", P3: "var(--ink-3)" };

function OptionList({ it, onResolve }) {
  const [picked, setPicked] = useState(null);
  const [help, setHelp] = useState(false);
  useEffect(() => { setPicked(null); setHelp(false); }, [it.id]);
  return (
    <div className="col gap10">
      <div className="ib-opts">
        {it.options.map((o, i) => (
          <button key={i} className={"ib-opt" + (picked === i ? " on" : "") + (it.recommend === i ? " rec" : "")}
            disabled={picked !== null}
            onClick={() => { setPicked(i); setTimeout(() => onResolve(it, o), 480); }}>
            {picked === i ? <IIcon name="check" size={14}/> : <span className="ib-optdot"></span>}
            <span className="grow" style={{ textAlign: "left" }}>{o}</span>
            {it.recommend === i && <span className="ib-rec"><IIcon name="star" size={11}/> recommended</span>}
          </button>
        ))}
      </div>
      <button className="ib-help-toggle" onClick={() => setHelp(h => !h)}>
        <IIcon name={help ? "chevD" : "chevR"} size={12}/> {help ? "Hide" : "Need help deciding?"}
      </button>
      {help && (
        <div className="ib-help fade-in">
          <div className="row gap6" style={{ marginBottom: 5 }}>
            <IModel id={it.model} small/>
            <span className="eyebrow" style={{ fontSize: 9 }}>RECOMMENDATION</span>
          </div>
          <p>{it.help}</p>
        </div>
      )}
    </div>
  );
}

function Detail({ it, onResolve, onReview }) {
  if (!it) return (
    <div className="ib-empty">
      <IIcon name="check" size={26} style={{ color: "var(--ok)" }}/>
      <span>Inbox zero.</span>
      <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Every agent is unblocked and working.</span>
    </div>
  );
  const m = TYPE_META[it.type];
  const p = iProj(it.project);
  return (
    <div className="ib-detail" key={it.id}>
      <div className="ib-detail-hd">
        <div className="row gap8" style={{ minWidth: 0, flexWrap: "wrap" }}>
          <span className="tag" style={{ color: m.color, borderColor: m.color }}>{m.label}</span>
          <span className="tag mono" style={{ color: PRIO_COLOR_INB[it.priority] }}>{it.priority}</span>
          <span className="mono ib-proj">{p.name}</span>
          <LabelTag label={p.label}/>
          {it.task && <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>{it.task}</span>}
        </div>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", flex: "none" }}>{it.ago}</span>
      </div>

      <h2 className="ib-detail-title">{it.title}</h2>
      <p className="ib-ctx">{it.ctx}</p>

      {it.type === "review" ? (
        <div className="col gap12">
          <div className="ib-reviewstats">
            <div className="rs"><span className="eyebrow">DIFF</span><span className="mono"><b style={{ color: "var(--ok)" }}>+{it.add}</b> / <b style={{ color: "var(--err)" }}>−{it.del}</b></span></div>
            <div className="rs"><span className="eyebrow">FILES</span><span className="tnum">{it.files}</span></div>
            <div className="rs"><span className="eyebrow">MODEL</span><IModel id={it.model} small/></div>
          </div>
          <div className="row gap8">
            <button className="btn btn-primary" onClick={() => onReview()}><IIcon name="review" size={14}/> Open full review</button>
            <button className="btn" onClick={() => onResolve(it, "approved & merged")}><IIcon name="branch" size={13}/> Approve & merge</button>
            <button className="btn btn-danger" onClick={() => onResolve(it, "sent back")}><IIcon name="x" size={13}/> Request changes</button>
          </div>
        </div>
      ) : (
        <OptionList it={it} onResolve={onResolve}/>
      )}
    </div>
  );
}

const TYPE_FILTERS = ["all", "question", "review", "blocked", "suggest"];
const TYPE_FILTER_LABEL = { all: "all", question: "questions", review: "reviews", blocked: "blocked", suggest: "suggestions" };

function Inbox({ projectFilter, setProjectFilter, onReview }) {
  const [items, setItems] = useState(window.NS.actions);
  const [resolved, setResolved] = useState([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [labelFilter, setLabelFilter] = useState("all");
  const [selId, setSelId] = useState(null);

  const sorted = useMemo(() => [...items].sort((a, b) =>
    PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]), [items]);
  const filtered = sorted.filter(it =>
    (typeFilter === "all" || it.type === typeFilter) &&
    (labelFilter === "all" || iProj(it.project).label === labelFilter) &&
    (!projectFilter || it.project === projectFilter));

  const selected = filtered.find(x => x.id === selId) || filtered[0] || null;
  const topId = filtered[0]?.id;

  const resolve = (it, choice) => {
    setResolved(r => [{ id: it.id, title: it.title, choice, type: it.type }, ...r]);
    setItems(prev => prev.filter(x => x.id !== it.id));
    setSelId(null);
  };

  const counts = TYPE_FILTERS.reduce((a, f) => (a[f] = f === "all"
    ? items.filter(it => (!projectFilter || it.project === projectFilter) && (labelFilter === "all" || iProj(it.project).label === labelFilter)).length
    : items.filter(it => it.type === f && (!projectFilter || it.project === projectFilter) && (labelFilter === "all" || iProj(it.project).label === labelFilter)).length, a), {});

  const agentsParallel = window.NS.projects.reduce((a, p) => a + p.agentsActive, 0);

  return (
    <div className="screen inbox-screen">
      {/* parallel banner */}
      <div className="ib-banner">
        <div className="row gap8">
          <IIcon name="bolt" size={15} style={{ color: "var(--star)" }}/>
          <span className="mono" style={{ fontSize: 12.5 }}><b style={{ color: "var(--ink)" }}>{agentsParallel} agents</b> working in parallel</span>
          <span style={{ color: "var(--line)" }}>·</span>
          <span className="mono" style={{ fontSize: 12.5, color: "var(--ink-2)" }}><b style={{ color: filtered.length ? "var(--star)" : "var(--ok)" }}>{filtered.length}</b> need a decision</span>
        </div>
        <span className="grow"></span>
        {/* label filter */}
        <div className="row gap6">
          {["all", "work", "personal"].map(l => (
            <button key={l} className={"chip" + (labelFilter === l ? " on" : "")} onClick={() => setLabelFilter(l)}>
              {l !== "all" && <span className={"lbl-dot lbl-" + l}></span>}{l}
            </button>
          ))}
        </div>
        {projectFilter && (
          <button className="chip on" onClick={() => setProjectFilter(null)} title="Clear project filter">
            <i className="dot dot-run"></i>{iProj(projectFilter).name}<IIcon name="x" size={11}/>
          </button>
        )}
      </div>

      <div className="inbox-grid">
        {/* master list */}
        <div className="panel brackets col" style={{ overflow: "hidden" }}>
          <div className="ib-typebar">
            {TYPE_FILTERS.map(f => (
              <button key={f} className={"ib-tab" + (typeFilter === f ? " on" : "")} onClick={() => setTypeFilter(f)}>
                {TYPE_FILTER_LABEL[f]}<span className="chip-n">{counts[f]}</span>
              </button>
            ))}
          </div>
          <div className="scroll grow">
            {filtered.length === 0
              ? <div className="ib-listempty"><IIcon name="check" size={20} style={{ color: "var(--ok)" }}/> nothing here</div>
              : filtered.map(it => (
                  <InboxRow key={it.id} it={it} active={selected?.id === it.id}
                    isNext={it.id === topId} onClick={setSelId}/>
                ))}
            {resolved.length > 0 && <div className="ib-resolved-hd eyebrow">RESOLVED · THIS SESSION</div>}
            {resolved.map((r, i) => (
              <div key={i} className="ib-resolved">
                <IIcon name="check" size={12} style={{ color: "var(--ok)" }}/>
                <span className="grow" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--ink-4)" }}>{r.choice}</span>
              </div>
            ))}
          </div>
        </div>

        {/* detail */}
        <div className="panel brackets" style={{ overflow: "auto" }}>
          <Detail it={selected} onResolve={resolve} onReview={onReview}/>
        </div>
      </div>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS.Inbox = Inbox;
