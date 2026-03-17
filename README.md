# 🏎️ DocRacer

**Learn by typing your own documents — at light speed.**

A Nitrotype-inspired typing game where you upload documents (TXT, DOCX, PDF up to 50 pages) and race through them by typing. Long documents are automatically split into ~5-page sections.

## Features

- **🏁 Racing UI** — Neon car advances on a racetrack as you type. Hit 10 perfect keystrokes for a NITRO BOOST.
- **📄 Document Upload** — Supports `.txt`, `.docx`, and `.pdf` files up to 50 pages.
- **✂️ Auto-Chunking** — Long documents split into ~5-page sections automatically.
- **⏭️ Click-to-Skip** — Click any line ahead to skip content you already know. WPM/accuracy only counts what you actually typed.
- **📊 Live Stats** — Real-time WPM, accuracy, time, and progress tracking.
- **⭐ Star Ratings** — 1–3 stars per section based on speed and accuracy.
- **💾 Persistent Progress** — Scores and documents saved across sessions via localStorage.
- **🗑️ Library Management** — Upload, track progress, and delete documents.

## Getting Started

```bash
git clone https://github.com/YOUR_USERNAME/docracer.git
cd docracer
npm install
npm run dev
```

Then open `http://localhost:5173` and upload a document to start racing!

## Deploy

```bash
npm run build
```

The `dist/` folder is ready to deploy to Vercel, Netlify, GitHub Pages, etc.

## Tech Stack

- **React** + **Vite**
- Zero external UI dependencies — pure CSS + inline styles
- Self-contained DOCX parser (reads ZIP structure natively)
- PDF text extraction (binary parsing)
- localStorage for persistence

## License

MIT
