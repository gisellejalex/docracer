import React from 'react'
import ReactDOM from 'react-dom/client'
import DocRacer from './DocRacer.jsx'

// Polyfill window.storage for local dev (uses localStorage)
if (!window.storage) {
  window.storage = {
    async get(key) {
      const val = localStorage.getItem(`docracer:${key}`);
      return val !== null ? { key, value: val, shared: false } : null;
    },
    async set(key, value) {
      localStorage.setItem(`docracer:${key}`, value);
      return { key, value, shared: false };
    },
    async delete(key) {
      localStorage.removeItem(`docracer:${key}`);
      return { key, deleted: true, shared: false };
    },
    async list(prefix = '') {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(`docracer:${prefix}`)) {
          keys.push(k.replace('docracer:', ''));
        }
      }
      return { keys, prefix, shared: false };
    },
  };
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DocRacer />
  </React.StrictMode>,
)
