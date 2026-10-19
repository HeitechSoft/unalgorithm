import '@unalgorithm/ui/styles.css';
import '../../styles/pages.css';
import './sidepanel.css';
import { ToastProvider } from '@unalgorithm/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StrictMode>,
  );
}
