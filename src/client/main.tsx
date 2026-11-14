/**
 * Responsibility: Browser React 19 entrypoint mounting `App` with Vervain visual tokens.
 * Trust boundary: Untrusted browser bundle; zero credentials or server modules imported.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/tokens.css';
import './styles/app.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
