import React from 'react'
import ReactDOM from 'react-dom/client'

// Polyfill window.storage for deployment outside Claude (uses localStorage)
// Must run BEFORE DocRacer imports
if (!window.storage || typeof window.storage.get !== 'function') {
  window.storage = {
    async get(key) {
      try {
        const val = localStorage.getItem(`docracer:${key}`);
        return val !== null ? { key, value: val, shared: false } : null;
      } catch { return null; }
    },
    async set(key, value) {
      try {
        localStorage.setItem(`docracer:${key}`, value);
        return { key, value, shared: false };
      } catch { return null; }
    },
    async delete(key) {
      try {
        localStorage.removeItem(`docracer:${key}`);
        return { key, deleted: true, shared: false };
      } catch { return null; }
    },
    async list(prefix = '') {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith(`docracer:${prefix}`)) {
            keys.push(k.replace('docracer:', ''));
          }
        }
        return { keys, prefix, shared: false };
      } catch { return { keys: [], prefix, shared: false }; }
    },
  };
}

import DocRacer from './DocRacer.jsx'

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <DocRacer />
    </React.StrictMode>,
  );
} else {
  console.error('DocRacer: #root element not found');
}
