/**
 * Responsibility: Browser React 19 entrypoint. The stock Vervain DataMap leak check is the default view;
 * the detailed evidence page (`App`) stays reachable at `#evidence`.
 * Trust boundary: Untrusted browser bundle; zero credentials or server modules imported.
 */

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { LeakCheck } from './leakcheck/LeakCheck.js';
import { VervainMark } from './workspace/Workspace.js';
import './styles/tokens.css';
import './styles/app.css';
import './workspace/workspace.css';

/** Evidence view: `#evidence`, or an existing replay deep link (`?run=...`). */
function currentView(): 'workspace' | 'evidence' {
  if (window.location.hash === '#evidence') return 'evidence';
  return new URLSearchParams(window.location.search).has('run') ? 'evidence' : 'workspace';
}

function Root() {
  const [view, setView] = useState(currentView);
  useEffect(() => {
    const onHash = () => setView(currentView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (view === 'workspace') return <LeakCheck />;
  return (
    <>
      <nav className="vw-evidence-bar" aria-label="Views">
        <VervainMark size={18} />
        <a href="/">Leak check</a>
        <a href="#evidence" className="is-current" aria-current="page">
          Evidence
        </a>
      </nav>
      <App />
    </>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
