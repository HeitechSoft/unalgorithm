import '@unalgorithm/ui/styles.css';
import './report.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

// The background points this tab at a newer draft from the same feed tab (another *Wrong call?* within the minute):
// the page loads that one.
window.addEventListener('hashchange', () => location.reload());

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
