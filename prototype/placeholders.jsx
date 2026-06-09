/* temporary placeholders — replaced by full screens */
(function () {
  function Stub({ name }) {
    return (
      <div className="screen" style={{ display: "grid", placeItems: "center" }}>
        <div className="panel brackets" style={{ padding: 40, textAlign: "center" }}>
          <div className="eyebrow">{name}</div>
          <div style={{ color: "var(--ink-3)", marginTop: 8 }}>under construction</div>
        </div>
      </div>
    );
  }
  window.SCREENS = window.SCREENS || {};
  if (!window.SCREENS.Queue)  window.SCREENS.Queue  = () => <Stub name="AGENT QUEUE"/>;
  if (!window.SCREENS.Graph)  window.SCREENS.Graph  = () => <Stub name="GRAPH COCKPIT"/>;
  if (!window.SCREENS.Review) window.SCREENS.Review = () => <Stub name="PATCH REVIEW"/>;
})();
