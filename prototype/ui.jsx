/* ============================================================
   NORTHSTAR — shared UI primitives  (window.UI)
   ============================================================ */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

/* --- simple geometric icon set (stroke-based, minimal) --- */
const PATHS = {
  dash:   "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  queue:  "M4 6h16M4 12h16M4 18h10",
  inbox:  "M3 13h5l1.5 2.5h5L21 13M3 13l2-8h14l2 8M3 13v6h18v-6",
  graph:  null, // drawn custom
  review: "M7 4v16M7 8h9a3 3 0 0 1 0 6H7M16 4a2 2 0 1 0 0 4M7 18a2 2 0 1 0 0 .01",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  plus:   "M12 5v14M5 12h14",
  mic:    "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4",
  chevD:  "M6 9l6 6 6-6",
  chevR:  "M9 6l6 6-6 6",
  cmd:    "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z",
  settings:"M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2",
  bolt:   "M13 3L5 13h6l-1 8 8-10h-6z",
  check:  "M5 12l4 4L19 7",
  x:      "M6 6l12 12M18 6L6 18",
  branch: "M7 4v12a3 3 0 0 0 3 3h7M7 4a2 2 0 1 0 0 .01M17 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4M7 8a2 2 0 1 0 0 .01",
  arrowR: "M5 12h14M13 6l6 6-6 6",
  pause:  "M8 5v14M16 5v14",
  play:   "M7 5l12 7-12 7z",
  alert:  "M12 4l9 16H3zM12 10v5M12 18v.01",
  filter: "M3 5h18l-7 8v6l-4-2v-4z",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  clock:  "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2",
};

function Icon({ name, size = 16, stroke = 1.6, className = "", style }) {
  if (name === "graph") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
           className={className} style={style}>
        <circle cx="6" cy="7" r="2.3" stroke="currentColor" strokeWidth={stroke}/>
        <circle cx="18" cy="6" r="2.3" stroke="currentColor" strokeWidth={stroke}/>
        <circle cx="13" cy="17" r="2.3" stroke="currentColor" strokeWidth={stroke}/>
        <path d="M8 8l4 7M16 8l-2 7" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"/>
      </svg>
    );
  }
  if (name === "star") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} style={style}>
        <path d="M12 2l1.6 7L21 12l-7.4 1.5L12 22l-1.6-8.5L3 12l7.4-1z"
              fill="currentColor" opacity="0.95"/>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         className={className} style={style} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} stroke="currentColor" strokeWidth={stroke}/>
    </svg>
  );
}

/* --- sparkline --- */
function Spark({ data, w = 64, h = 20, color = "var(--star)" }) {
  const max = Math.max(...data), min = Math.min(...data);
  const rng = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / rng) * (h - 3) - 1.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  const id = useMemo(() => "sg" + Math.random().toString(36).slice(2, 7), []);
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polyline points={area} fill={`url(#${id})`} stroke="none"/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
                strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  );
}

/* --- circular health ring --- */
function Ring({ value, size = 34, stroke = 3, color }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const col = color || (value > 0.8 ? "var(--ok)" : value > 0.6 ? "var(--star)" : "var(--err)");
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--panel-3)" strokeWidth={stroke}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={stroke}
              strokeDasharray={c} strokeDashoffset={c * (1 - value)} strokeLinecap="round"
              style={{ transition: "stroke-dashoffset .6s ease" }}/>
    </svg>
  );
}

const STATUS = {
  running:      { dot: "dot-run",   label: "RUNNING",   live: true },
  "needs-input":{ dot: "dot-queue", label: "NEEDS INPUT", color: "var(--cyan)" },
  queued:       { dot: "dot-queue", label: "QUEUED" },
  blocked:      { dot: "dot-block", label: "BLOCKED",   color: "var(--err)" },
  done:         { dot: "dot-done",  label: "DONE",      color: "var(--ok)" },
  idle:         { dot: "dot-idle",  label: "IDLE" },
};

function StatusTag({ status, small }) {
  const s = STATUS[status] || STATUS.idle;
  return (
    <span className="tag" style={{ paddingLeft: 6, ...(s.color ? { color: s.color, borderColor: s.color, background: "transparent" } : {}) }}>
      <i className={"dot " + s.dot + (s.live ? " live" : "")}></i>
      {!small && s.label}
    </span>
  );
}

const fmtNum = (n) => n >= 1000 ? (n/1000).toFixed(n >= 100000 ? 0 : 1) + "k" : "" + n;
const pct = (n) => Math.round(n * 100) + "%";

const MODEL_COLOR = { opus: "var(--c1)", codex: "var(--c4)", spark: "var(--cyan)" };
function ModelChip({ id, small }) {
  const m = (window.NS.MODELS || []).find(x => x.id === id) || { label: id };
  return (
    <span className="tag mono" style={{ gap: 5, color: "var(--ink-2)" }}>
      <i className="dot" style={{ background: MODEL_COLOR[id] || "var(--ink-3)" }}></i>
      {small ? id.toUpperCase() : m.label}{m.local && !small && <span style={{ color: "var(--ink-4)" }}>· local</span>}
    </span>
  );
}

window.UI = { Icon, Spark, Ring, StatusTag, ModelChip, fmtNum, pct, STATUS, MODEL_COLOR };
