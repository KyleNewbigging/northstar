/* ============================================================
   NORTHSTAR — app shell + state + tweaks   (mounts #root)
   ============================================================ */
const { Rail, HUD, CommandBar } = window.SHELL;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "visualStyle": "deep-space",
  "dashboardLayout": "cards",
  "graphLayout": "constellation",
  "reviewLayout": "split",
  "starfield": true,
  "glow": true,
  "accent": "#ffb454"
}/*EDITMODE-END*/;

function Toast({ msg, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3400); return () => clearTimeout(t); }, []);
  return (
    <div className="toast fade-in">
      <i className="dot dot-run live"></i>
      <span className="mono" style={{ fontSize: 12 }}>{msg}</span>
    </div>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = useState("dashboard");
  const [model, setModel] = useState("opus");
  const [toast, setToast] = useState(null);
  const [inboxProject, setInboxProject] = useState(null);

  // apply visual style + accent to root
  useEffect(() => {
    const r = document.documentElement;
    r.setAttribute("data-style", t.visualStyle);
    r.setAttribute("data-glow", t.glow ? "on" : "off");
    if (t.accent) r.style.setProperty("--star", t.accent);
    else r.style.removeProperty("--star");
  }, [t.visualStyle, t.glow, t.accent]);

  const openProject = useCallback((p) => { setInboxProject(p.id); setView("inbox"); }, []);
  const handleNav = useCallback((v) => { if (v === "inbox") setInboxProject(null); setView(v); }, []);
  const dispatch = useCallback((text, m, ctx) => {
    setToast(`Dispatched to ${window.NS.MODELS.find(x=>x.id===m)?.label} · scoped to ${ctx}`);
  }, []);

  const S = window.SCREENS;
  let screen = null;
  if (view === "dashboard") screen = <S.Dashboard layout={t.dashboardLayout} onOpenProject={openProject}/>;
  else if (view === "inbox") screen = <S.Inbox projectFilter={inboxProject} setProjectFilter={setInboxProject} onReview={() => setView("review")}/>;
  else if (view === "queue") screen = <S.Queue onReview={() => setView("review")} onGraph={() => setView("graph")}/>;
  else if (view === "graph") screen = <S.Graph layout={t.graphLayout} onReview={() => setView("review")}/>;
  else if (view === "review") screen = <S.Review layout={t.reviewLayout} onBack={() => setView("queue")}/>;

  return (
    <React.Fragment>
      {t.starfield && <div className="starfield"></div>}
      <div className="gridwash"></div>
      <div className="app">
        <Rail view={view} setView={handleNav}/>
        <HUD view={view}/>
        <main className="main">{screen}</main>
        <CommandBar onSend={dispatch} model={model} setModel={setModel}/>
      </div>

      {toast && <Toast msg={toast} onDone={() => setToast(null)}/>}

      <TweaksPanel>
        <TweakSection label="Visual style"/>
        <TweakRadio label="Mood" value={t.visualStyle}
          options={["deep-space", "observatory", "carbon"]}
          onChange={v => setTweak("visualStyle", v)}/>
        <TweakColor label="North-star accent" value={t.accent}
          options={["#ffb454", "#7fd5ff", "#c9a6ff", "#5fe3b0", "#ff8f6b"]}
          onChange={v => setTweak("accent", v)}/>
        <TweakToggle label="Starfield" value={t.starfield} onChange={v => setTweak("starfield", v)}/>
        <TweakToggle label="Glow accents" value={t.glow} onChange={v => setTweak("glow", v)}/>

        <TweakSection label="Dashboard layout"/>
        <TweakRadio label="Arrangement" value={t.dashboardLayout}
          options={["cards", "list", "mosaic"]}
          onChange={v => { setTweak("dashboardLayout", v); setView("dashboard"); }}/>

        <TweakSection label="Graph cockpit"/>
        <TweakRadio label="Layout" value={t.graphLayout}
          options={["constellation", "dag", "swimlane"]}
          onChange={v => { setTweak("graphLayout", v); setView("graph"); }}/>

        <TweakSection label="Patch review"/>
        <TweakRadio label="Diff style" value={t.reviewLayout}
          options={["split", "unified", "stacked"]}
          onChange={v => { setTweak("reviewLayout", v); setView("review"); }}/>
      </TweaksPanel>
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
