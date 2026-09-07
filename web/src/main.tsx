import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { announceUnload } from './unload';
import './nocturne.css';
import './app.css';

announceUnload();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
