/**
 * Responsibility: Minimal client bootstrap placeholder prior to M4 UI completion.
 * Trust boundary: Untrusted browser bundle; holds zero credentials or authority.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <div>Vervain Context Firewall</div>
    </StrictMode>,
  );
}
