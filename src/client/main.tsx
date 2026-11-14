/**
 * Responsibility: Browser React 19 entrypoint. The Vervain workspace is the default view;
 * the detailed evidence page (`App`) stays reachable at `#evidence`.
 * Trust boundary: Untrusted browser bundle; zero credentials or server modules imported.
 */

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { VervainMark, Workspace } from './workspace/Workspace.js';
import './styles/tokens.css';
import './styles/app.css';
import './workspace/workspace.css';

function currentView(): 'workspace' | 'evidence' {
  return window.location.hash === '#evidence' ? 'evidence' : 'workspace';
}

function Root() {
  const [view, setView] = useState(currentView);
  useEffect(() => {
    const onHash = () => setView(currentView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (view === 'workspace') return <Workspace />;
  return (
    <>
      <nav className="vw-evidence-bar" aria-label="Views">
        <VervainMark size={18} />
        <a href="#">Workspace</a>
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
