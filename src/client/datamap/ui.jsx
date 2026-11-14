/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
// Shared primitives for the one workspace. Both tabs use the same paging, tags,
// empty states and copy control, so a reader learns one set of controls once.
import React, { useEffect, useId, useRef, useState } from "react";

export const short = (value) =>
  typeof value === "string" ? value.slice(0, 12) : "Unobserved";
export const plain = (value) => String(value ?? "Unobserved").replaceAll("_", " ");
const CUBE_TOP = "160,35.381 263.923,95.381 160,155.381 56.077,95.381";
const CUBE_LEFT = "52.077,102.309 156,162.309 156,282.309 52.077,222.309";
const CUBE_RIGHT = "164,162.309 267.923,102.309 267.923,222.309 164,282.309";

export function Cube({ size = 28, glass = false, attention = false, lift = 0, open = false }) {
  const uid = useId().replaceAll(":", "");
  const edge = attention ? "var(--purple)" : "rgba(255,255,255,.4)";
  const base = 2.5;
  const separation = base + lift * 12;
  const topLift = separation + (open ? 48 : 0);
  const panelOpen = open ? 26 : 0;
  if (!glass || size < 30) {
    return (
      <svg width={size} height={size} viewBox="0 0 320 320" fill="none" aria-hidden="true">
        <g transform={`translate(0 ${-base})`}><polygon points={CUBE_TOP} fill="rgba(255,255,255,.10)" stroke={edge} strokeWidth="3" /></g>
        <g transform={`translate(${-base * .866} ${base * .5})`}><polygon points={CUBE_LEFT} fill="rgba(255,255,255,.045)" stroke={edge} strokeWidth="3" /></g>
        <g transform={`translate(${base * .866} ${base * .5})`}><polygon points={CUBE_RIGHT} fill="rgba(255,255,255,.07)" stroke={edge} strokeWidth="3" /></g>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 320 320" fill="none" aria-hidden="true" style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={`${uid}-top`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="rgba(230,240,255,.20)" />
          <stop offset="40%" stopColor="rgba(255,210,230,.10)" />
          <stop offset="70%" stopColor="rgba(200,255,220,.10)" />
          <stop offset="100%" stopColor="rgba(255,255,255,.05)" />
        </linearGradient>
        <linearGradient id={`${uid}-left`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="rgba(190,200,255,.15)" /><stop offset="100%" stopColor="rgba(255,255,255,.02)" /></linearGradient>
        <linearGradient id={`${uid}-right`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="rgba(200,210,255,.15)" /><stop offset="100%" stopColor="rgba(255,255,255,.04)" /></linearGradient>
      </defs>
      <g className="cube-lid" style={{transform: `translate(0px, ${-topLift}px)`, transformOrigin: "56px 95px"}}><polygon points={CUBE_TOP} fill="rgba(20,20,20,.2)" /><polygon points={CUBE_TOP} fill={`url(#${uid}-top)`} opacity={attention ? .75 : .6 + lift * .2} /><polygon points={CUBE_TOP} fill="none" stroke={edge} strokeWidth="1.5" /></g>
      <g className="cube-panel" style={{transform: `translate(${-separation * .866 - panelOpen}px, ${separation * .5 + panelOpen * .45}px)`}}><polygon points={CUBE_LEFT} fill="rgba(20,20,20,.3)" /><polygon points={CUBE_LEFT} fill={`url(#${uid}-left)`} opacity={attention ? .65 : .5 + lift * .2} /><polygon points={CUBE_LEFT} fill="none" stroke={edge} strokeWidth="1.5" opacity=".85" /></g>
      <g className="cube-panel" style={{transform: `translate(${separation * .866 + panelOpen}px, ${separation * .5 + panelOpen * .45}px)`}}><polygon points={CUBE_RIGHT} fill="rgba(20,20,20,.25)" /><polygon points={CUBE_RIGHT} fill={`url(#${uid}-right)`} opacity={attention ? .65 : .5 + lift * .2} /><polygon points={CUBE_RIGHT} fill="none" stroke={edge} strokeWidth="1.5" opacity=".92" /></g>
    </svg>
  );
}

/** @returns {[React.RefObject<any>, number]} */
export function useRows(reserve, rowHeight, maximum = 6) {
  const ref = useRef(null),
    [rows, setRows] = useState(3);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setRows(
        Math.max(
          1,
          Math.min(
            maximum,
            Math.floor((entry.contentRect.height - reserve) / rowHeight),
          ),
        ),
      ),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [reserve, rowHeight, maximum, ref.current]);
  return [ref, rows];
}

export function Tag({ children, tone = "" }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
export function Pager({ page, pages, setPage, label = "Page" }) {
  return (
    <div className="pager">
      <button
        aria-label={`Previous ${label}`}
        disabled={page <= 0}
        onClick={() => setPage(page - 1)}
      >
        ‹
      </button>
      <span>
        {Math.min(page + 1, Math.max(1, pages))} / {Math.max(1, pages)}
      </span>
      <button
        aria-label={`Next ${label}`}
        disabled={page + 1 >= pages}
        onClick={() => setPage(page + 1)}
      >
        ›
      </button>
    </div>
  );
}
export function Empty({ title: heading, children }) {
  return (
    <div className="empty">
      <Cube size={42} />
      <h2>{heading}</h2>
      <p>{children}</p>
    </div>
  );
}
export function Copy({ value, children = "Copy command" }) {
  const [state, set] = useState("");
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          set("Copied");
        } catch {
          set("Select the command to copy");
        }
      }}
    >
      {state || children}
    </button>
  );
}
export async function post(path, token, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    credentials: "omit",
    body: JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || "The change could not be saved");
  return value;
}
export function download(value, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
