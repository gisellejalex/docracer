import { useState, useEffect, useRef, useCallback } from "react";
import JSZip from "jszip";

// ─── CONSTANTS ───
const CHUNK_SIZE = 5;
const CHARS_PER_PAGE = 2000;
const NITRO_STREAK = 10;
const LINE_CHAR_WIDTH = 52;

// ─── Load PDF.js from CDN ───
let pdfjsReady = null;
function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
    script.type = "module";
    // Use classic script tag approach for broader compat
    const s2 = document.createElement("script");
    s2.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.js";
    s2.onload = () => {
      const lib = window.pdfjsLib;
      if (lib) {
        lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.js";
        resolve(lib);
      } else { reject(new Error("PDF.js failed to load")); }
    };
    s2.onerror = () => reject(new Error("Could not load PDF.js from CDN"));
    document.head.appendChild(s2);
  });
  return pdfjsReady;
}

// ─── UTILITY: Parse uploaded files ───

async function parseDocx(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Invalid DOCX — no document.xml found.");
  const docXml = await docFile.async("string");
  return docXml
    .replace(/<w:p[^>]*\/>/g, "\n")
    .replace(/<w:p[ >]/g, "\n<w:p ")
    .replace(/<w:tab\/>/g, " ")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function parsePdf(arrayBuffer) {
  const pdfjsLib = await loadPdfJs();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const textParts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(" ");
    textParts.push(pageText);
  }
  const text = textParts.join("\n\n").replace(/\s+/g, " ").trim();
  if (!text || text.length < 10) throw new Error("Could not extract text from this PDF. It may be scanned/image-based.");
  return text;
}

function parseRtf(text) {
  // Strip RTF control words and groups, extract plain text
  let result = text
    .replace(/\{\\pict[\s\S]*?\\blipuid\s[\da-fA-F]+\}?/g, "") // remove images
    .replace(/\\par[d]?/g, "\n") // paragraph breaks
    .replace(/\\tab/g, " ") // tabs
    .replace(/\\line/g, "\n") // line breaks
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))) // hex chars
    .replace(/\\[a-z]+\d*\s?/gi, "") // control words
    .replace(/[{}]/g, "") // braces
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return result;
}

function parseHtml(text) {
  // Strip HTML tags, decode entities, keep text
  const doc = new DOMParser().parseFromString(text, "text/html");
  return (doc.body.textContent || doc.body.innerText || "").replace(/\s+/g, " ").trim();
}

async function extractText(file) {
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop();

  // Plain text formats
  if (["txt", "md", "csv", "tsv", "log", "json", "xml", "yml", "yaml", "ini", "cfg"].includes(ext)) {
    return await file.text();
  }

  // DOCX
  if (ext === "docx") {
    return await parseDocx(await file.arrayBuffer());
  }

  // PDF
  if (ext === "pdf") {
    return await parsePdf(await file.arrayBuffer());
  }

  // RTF
  if (ext === "rtf") {
    const raw = await file.text();
    return parseRtf(raw);
  }

  // HTML / HTM
  if (ext === "html" || ext === "htm") {
    const raw = await file.text();
    return parseHtml(raw);
  }

  // DOC (old Word format) — limited extraction
  if (ext === "doc") {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let text = "";
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c >= 32 && c < 127) text += String.fromCharCode(c);
      else if (c === 13 || c === 10) text += "\n";
      else text += " ";
    }
    // Clean up: collapse whitespace, remove junk runs
    text = text.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    // Filter out lines that look like binary junk (lots of special chars)
    const lines = text.split("\n").filter(line => {
      const printable = line.replace(/[^a-zA-Z0-9 .,;:!?'"()\-]/g, "");
      return printable.length > line.length * 0.5;
    });
    text = lines.join("\n").trim();
    if (text.length < 20) throw new Error("Could not extract text from this .doc file. Try saving as .docx or .txt first.");
    return text;
  }

  throw new Error(`Unsupported file type: .${ext}. Supported: PDF, DOCX, DOC, TXT, RTF, HTML, MD, CSV, and more.`);
}

function chunkText(text, chunkCharSize) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + chunkCharSize, text.length);
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(". ", end);
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastPeriod > i + chunkCharSize * 0.7) end = lastPeriod + 1;
      else if (lastSpace > i + chunkCharSize * 0.5) end = lastSpace;
    }
    const chunk = text.slice(i, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    i = end;
  }
  return chunks;
}

function textToLines(text) {
  const lines = [];
  let lineStart = 0;
  let col = 0;
  let lastSpace = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " ") lastSpace = i;
    col++;
    if (col >= LINE_CHAR_WIDTH && lastSpace > lineStart) {
      lines.push({ start: lineStart, end: lastSpace + 1 });
      lineStart = lastSpace + 1;
      col = i - lastSpace;
      lastSpace = -1;
    }
  }
  if (lineStart < text.length) lines.push({ start: lineStart, end: text.length });
  return lines;
}

// ─── STORAGE HELPERS ───
async function loadLibrary() {
  try { const r = await window.storage.get("docracer-library"); return r ? JSON.parse(r.value) : []; } catch { return []; }
}
async function saveLibrary(library) {
  try { await window.storage.set("docracer-library", JSON.stringify(library)); } catch (e) { console.error("Save failed:", e); }
}
async function loadDocChunks(docId) {
  try { const r = await window.storage.get(`docracer-chunks:${docId}`); return r ? JSON.parse(r.value) : null; } catch { return null; }
}
async function saveDocChunks(docId, chunks) {
  try { await window.storage.set(`docracer-chunks:${docId}`, JSON.stringify(chunks)); } catch (e) { console.error("Save failed:", e); }
}

// ─── NEON CAR SVG ───
function NeonCar({ nitroActive, color = "#0ff" }) {
  return (
    <svg width="80" height="36" viewBox="0 0 80 36" style={{ filter: nitroActive ? `drop-shadow(0 0 12px ${color}) drop-shadow(0 0 24px ${color})` : `drop-shadow(0 0 4px ${color})`, transition: "filter 0.3s" }}>
      <rect x="8" y="12" width="60" height="16" rx="4" fill="transparent" stroke={color} strokeWidth="1.5" />
      <rect x="22" y="6" width="30" height="12" rx="3" fill="transparent" stroke={color} strokeWidth="1.5" />
      <line x1="32" y1="6" x2="32" y2="18" stroke={color} strokeWidth="1" opacity="0.5" />
      <circle cx="20" cy="30" r="5" fill="transparent" stroke={color} strokeWidth="1.5" />
      <circle cx="58" cy="30" r="5" fill="transparent" stroke={color} strokeWidth="1.5" />
      <circle cx="20" cy="30" r="2" fill={color} opacity="0.6" />
      <circle cx="58" cy="30" r="2" fill={color} opacity="0.6" />
      {nitroActive && (
        <>
          <line x1="2" y1="20" x2="-12" y2="18" stroke="#f0f" strokeWidth="2" opacity="0.9"><animate attributeName="x2" values="-12;-20;-12" dur="0.2s" repeatCount="indefinite" /></line>
          <line x1="2" y1="24" x2="-16" y2="26" stroke="#f0f" strokeWidth="1.5" opacity="0.7"><animate attributeName="x2" values="-16;-24;-16" dur="0.15s" repeatCount="indefinite" /></line>
          <line x1="2" y1="22" x2="-10" y2="22" stroke="#ff0" strokeWidth="1" opacity="0.5"><animate attributeName="x2" values="-10;-18;-10" dur="0.18s" repeatCount="indefinite" /></line>
        </>
      )}
    </svg>
  );
}

function Racetrack({ progress, nitroActive }) {
  const trackWidth = 700;
  const carX = Math.min(progress, 1) * (trackWidth - 90);
  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 740, margin: "0 auto", padding: "18px 20px 10px" }}>
      <div style={{ position: "relative", height: 56, borderRadius: 28, background: "linear-gradient(90deg, rgba(0,255,255,0.04), rgba(255,0,255,0.06))", border: "1px solid rgba(0,255,255,0.15)", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "repeating-linear-gradient(90deg, rgba(0,255,255,0.2) 0px, rgba(0,255,255,0.2) 12px, transparent 12px, transparent 28px)" }} />
        <div style={{ position: "absolute", top: 0, left: 0, width: `${progress * 100}%`, height: "100%", background: "linear-gradient(90deg, transparent, rgba(0,255,255,0.08), rgba(255,0,255,0.1))", transition: "width 0.15s" }} />
        <div style={{ position: "absolute", left: carX, top: 10, transition: "left 0.15s ease-out" }}>
          <NeonCar nitroActive={nitroActive} />
        </div>
      </div>
      <div style={{ position: "absolute", right: 16, top: 8, fontSize: 20, opacity: 0.5 }}>🏁</div>
    </div>
  );
}

// ─── TYPING DISPLAY WITH CLICKABLE LINES ───
function TypingDisplay({ text, currentIndex, errors, skippedRanges, onSkipToLine }) {
  const containerRef = useRef(null);
  const cursorRef = useRef(null);
  const [hoveredLine, setHoveredLine] = useState(-1);
  const [confirmLine, setConfirmLine] = useState(-1);
  const lines = textToLines(text);

  useEffect(() => {
    if (cursorRef.current && containerRef.current) {
      const container = containerRef.current;
      const cursor = cursorRef.current;
      const containerRect = container.getBoundingClientRect();
      const cursorRect = cursor.getBoundingClientRect();
      const relativeTop = cursorRect.top - containerRect.top;
      if (relativeTop > containerRect.height * 0.55 || relativeTop < 0) {
        container.scrollTop += relativeTop - containerRect.height * 0.3;
      }
    }
  }, [currentIndex]);

  useEffect(() => { setConfirmLine(-1); }, [currentIndex]);

  const isCharSkipped = (idx) => {
    for (const r of skippedRanges) { if (idx >= r.start && idx < r.end) return true; }
    return false;
  };

  const handleLineClick = (lineIdx, e) => {
    e.stopPropagation();
    const line = lines[lineIdx];
    if (line.start <= currentIndex) return;
    if (confirmLine === lineIdx) {
      onSkipToLine(line.start);
      setConfirmLine(-1);
    } else {
      setConfirmLine(lineIdx);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <div ref={containerRef} style={{
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Source Code Pro', monospace",
        fontSize: 17, lineHeight: 2.1, padding: "20px 24px 20px 44px",
        background: "rgba(0,0,0,0.5)", border: "1px solid rgba(0,255,255,0.12)",
        borderRadius: 12, height: 280, overflowY: "auto", overflowX: "hidden",
        wordBreak: "break-word", whiteSpace: "pre-wrap", scrollBehavior: "smooth", position: "relative",
      }}>
        {lines.map((line, li) => {
          const lineChars = text.slice(line.start, line.end);
          const isAhead = line.start > currentIndex;
          const isHovered = hoveredLine === li && isAhead;
          const isConfirm = confirmLine === li;
          const isCurLine = currentIndex >= line.start && currentIndex < line.end;

          return (
            <div key={li}
              onClick={(e) => handleLineClick(li, e)}
              onMouseEnter={() => isAhead && setHoveredLine(li)}
              onMouseLeave={() => { setHoveredLine(-1); }}
              style={{
                position: "relative",
                cursor: isAhead ? "pointer" : "default",
                background: isConfirm ? "rgba(255,0,255,0.08)" : isHovered ? "rgba(0,255,255,0.04)" : "transparent",
                borderRadius: 4, margin: "0 -8px", padding: "0 8px",
                transition: "background 0.15s",
                borderLeft: isCurLine ? "3px solid #0ff" : "3px solid transparent",
                paddingLeft: isCurLine ? 5 : 8,
              }}
            >
              {/* Line number */}
              <span style={{
                position: "absolute", left: -34, top: 0, fontSize: 10,
                color: isCurLine ? "rgba(0,255,255,0.5)" : "rgba(180,190,210,0.15)",
                fontWeight: 600, lineHeight: "2.1em", width: 24, textAlign: "right",
                userSelect: "none", fontFamily: "'Orbitron', sans-serif",
              }}>{li + 1}</span>

              {/* Skip confirm tooltip */}
              {isConfirm && (
                <span style={{
                  position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                  fontSize: 10, color: "#f0f", background: "rgba(255,0,255,0.15)",
                  border: "1px solid rgba(255,0,255,0.3)", borderRadius: 4, padding: "2px 8px",
                  letterSpacing: 1, fontWeight: 700, zIndex: 5, whiteSpace: "nowrap",
                  pointerEvents: "none", animation: "pulse 1s infinite",
                }}>CLICK AGAIN TO SKIP HERE</span>
              )}

              {/* Skip hover hint */}
              {isHovered && !isConfirm && (
                <span style={{
                  position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                  fontSize: 10, color: "rgba(0,255,255,0.5)", letterSpacing: 1,
                  fontWeight: 600, zIndex: 5, whiteSpace: "nowrap", pointerEvents: "none",
                }}>⏭ SKIP TO LINE</span>
              )}

              {/* Characters */}
              {lineChars.split("").map((char, ci) => {
                const globalIdx = line.start + ci;
                const isSkipped = isCharSkipped(globalIdx);
                const isError = errors.has(globalIdx);
                const isTyped = globalIdx < currentIndex;
                const isCurrent = globalIdx === currentIndex;
                let color = "rgba(180,190,210,0.35)";
                let bg = "transparent";
                if (isSkipped) { color = "rgba(180,190,210,0.12)"; }
                else if (isTyped && !isError) { color = "#0ff"; }
                else if (isTyped && isError) { color = "#ff3366"; bg = "rgba(255,51,102,0.15)"; }
                if (isCurrent) { bg = "rgba(0,255,255,0.15)"; }
                return (
                  <span key={ci} ref={isCurrent ? cursorRef : null}
                    style={{
                      color, background: bg,
                      borderBottom: isCurrent ? "2px solid #0ff" : "none",
                      transition: "color 0.1s",
                      textShadow: isTyped && !isError && !isSkipped ? "0 0 8px rgba(0,255,255,0.4)" : "none",
                      textDecoration: isSkipped ? "line-through" : "none",
                      textDecorationColor: "rgba(180,190,210,0.15)",
                    }}>{char}</span>
                );
              })}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 8, flexWrap: "wrap", fontSize: 10, color: "rgba(180,190,210,0.3)" }}>
        <span>🖱️ Click a line ahead to skip</span>
        <span><span style={{ color: "#0ff" }}>●</span> Typed</span>
        <span><span style={{ color: "#f36" }}>●</span> Error</span>
        <span style={{ textDecoration: "line-through", textDecorationColor: "rgba(180,190,210,0.2)" }}>Skipped</span>
      </div>
    </div>
  );
}

// ─── STATS BAR ───
function StatsBar({ wpm, accuracy, elapsed, progress, skippedCount }) {
  const formatTime = (s) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
  return (
    <div style={{ display: "flex", gap: 20, justifyContent: "center", flexWrap: "wrap", padding: "12px 0" }}>
      {[
        { label: "WPM", value: wpm, color: "#0ff" },
        { label: "ACCURACY", value: `${accuracy}%`, color: accuracy >= 95 ? "#0f6" : accuracy >= 85 ? "#ff0" : "#f36" },
        { label: "TIME", value: formatTime(elapsed), color: "#c8f" },
        { label: "PROGRESS", value: `${Math.round(progress * 100)}%`, color: "#f90" },
        ...(skippedCount > 0 ? [{ label: "SKIPPED", value: skippedCount, color: "rgba(180,190,210,0.4)" }] : []),
      ].map((stat) => (
        <div key={stat.label} style={{ textAlign: "center", minWidth: 68 }}>
          <div style={{ fontSize: 10, letterSpacing: 2, color: "rgba(180,190,210,0.5)", fontWeight: 600, marginBottom: 3 }}>{stat.label}</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: stat.color, textShadow: `0 0 12px ${stat.color}44`, fontFamily: "'Orbitron', sans-serif" }}>{stat.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── RESULTS SCREEN ───
function ResultsScreen({ wpm, accuracy, time, errors, skipped, onNext, onReplay, onLibrary, hasNext }) {
  const stars = accuracy >= 98 && wpm >= 60 ? 3 : accuracy >= 90 && wpm >= 30 ? 2 : 1;
  return (
    <div style={{ textAlign: "center", padding: "40px 20px" }}>
      <div style={{ fontSize: 14, letterSpacing: 6, color: "rgba(0,255,255,0.5)", marginBottom: 8 }}>RACE COMPLETE</div>
      <div style={{ fontSize: 48, marginBottom: 24 }}>
        {[1, 2, 3].map((s) => (
          <span key={s} style={{ fontSize: 48, margin: "0 4px", filter: s <= stars ? "drop-shadow(0 0 8px #ff0)" : "grayscale(1) opacity(0.3)" }}>⭐</span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 28, justifyContent: "center", flexWrap: "wrap", marginBottom: 32 }}>
        {[
          { label: "WPM", value: wpm, color: "#0ff" },
          { label: "ACCURACY", value: `${accuracy}%`, color: "#0f6" },
          { label: "TIME", value: `${Math.floor(time / 60)}m ${Math.floor(time % 60)}s`, color: "#c8f" },
          { label: "ERRORS", value: errors, color: "#f36" },
          ...(skipped > 0 ? [{ label: "SKIPPED", value: `${skipped} chars`, color: "rgba(180,190,210,0.4)" }] : []),
        ].map((s) => (
          <div key={s.label} style={{ minWidth: 80 }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: "rgba(180,190,210,0.4)", marginBottom: 5 }}>{s.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: s.color, fontFamily: "'Orbitron', sans-serif", textShadow: `0 0 10px ${s.color}44` }}>{s.value}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <button onClick={onReplay} style={btnStyle("#333", "#0ff")}>↻ Replay</button>
        {hasNext && <button onClick={onNext} style={btnStyle("rgba(0,255,255,0.15)", "#0ff")}>Next Section →</button>}
        <button onClick={onLibrary} style={btnStyle("#222", "#888")}>Sections</button>
      </div>
    </div>
  );
}

const btnStyle = (bg, color) => ({
  padding: "12px 28px", background: bg, color,
  border: `1px solid ${color}33`, borderRadius: 8,
  fontSize: 14, fontWeight: 700, cursor: "pointer",
  letterSpacing: 1, fontFamily: "'Orbitron', 'JetBrains Mono', monospace", transition: "all 0.2s",
});

// ─── DOCUMENT LIBRARY ───
function Library({ library, onSelect, onUpload, uploading, uploadError, onDelete }) {
  return (
    <div style={{ padding: "20px 0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, letterSpacing: 6, color: "rgba(0,255,255,0.4)", fontWeight: 600 }}>DOCUMENT LIBRARY</div>
          <div style={{ fontSize: 11, color: "rgba(180,190,210,0.25)", marginTop: 4 }}>Upload study materials and practice typing them</div>
        </div>
        <label style={{ ...btnStyle("rgba(0,255,255,0.1)", "#0ff"), display: "inline-flex", alignItems: "center", gap: 8, position: "relative" }}>
          {uploading ? "Processing…" : "＋ Upload Document"}
          <input type="file" accept=".txt,.md,.docx,.doc,.pdf,.rtf,.html,.htm,.csv,.tsv,.log,.json,.xml,.yml,.yaml" onChange={onUpload} disabled={uploading}
            style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }} />
        </label>
      </div>
      {uploadError && <div style={{ color: "#f36", marginBottom: 16, fontSize: 13 }}>{uploadError}</div>}
      {library.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>📄</div>
          <div style={{ color: "rgba(180,190,210,0.4)", fontSize: 15, maxWidth: 380, margin: "0 auto", lineHeight: 1.7 }}>
            Upload a document to start learning.<br />Supports PDF, DOCX, DOC, RTF, TXT, HTML, MD, CSV, and more — up to 50 pages.<br />
            <span style={{ color: "rgba(0,255,255,0.3)", fontSize: 12 }}>Tip: Click any line ahead to skip sections you already know!</span>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {library.map((doc) => {
            const completed = doc.chunkScores ? doc.chunkScores.filter(Boolean).length : 0;
            const total = doc.totalChunks;
            const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
            return (
              <div key={doc.id} style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
                <div onClick={() => onSelect(doc)}
                  style={{
                    flex: 1, padding: "16px 20px",
                    background: "rgba(0,255,255,0.03)", border: "1px solid rgba(0,255,255,0.1)",
                    borderRadius: "10px 0 0 10px", cursor: "pointer", transition: "all 0.2s",
                    display: "flex", alignItems: "center", gap: 16,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(0,255,255,0.35)"; e.currentTarget.style.background = "rgba(0,255,255,0.06)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(0,255,255,0.1)"; e.currentTarget.style.background = "rgba(0,255,255,0.03)"; }}
                >
                  <div style={{ fontSize: 28, opacity: 0.5 }}>📄</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#e0e8f0", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name}</div>
                    <div style={{ fontSize: 12, color: "rgba(180,190,210,0.4)" }}>
                      {total} section{total !== 1 ? "s" : ""} • {doc.pages} page{doc.pages !== 1 ? "s" : ""}
                      {doc.bestWpm ? ` • Best: ${doc.bestWpm} WPM` : ""}
                    </div>
                  </div>
                  <div style={{ minWidth: 56, textAlign: "right" }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: pct === 100 ? "#0f6" : "#0ff", fontFamily: "'Orbitron', sans-serif" }}>{pct}%</div>
                    <div style={{ fontSize: 10, color: "rgba(180,190,210,0.3)", letterSpacing: 1 }}>{completed}/{total}</div>
                  </div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); onDelete(doc.id); }}
                  style={{
                    background: "rgba(255,51,102,0.06)", border: "1px solid rgba(255,51,102,0.15)",
                    borderLeft: "none", borderRadius: "0 10px 10px 0",
                    color: "rgba(255,51,102,0.4)", cursor: "pointer", padding: "0 14px",
                    fontSize: 16, transition: "all 0.2s", display: "flex", alignItems: "center",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "#f36"; e.currentTarget.style.background = "rgba(255,51,102,0.12)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(255,51,102,0.4)"; e.currentTarget.style.background = "rgba(255,51,102,0.06)"; }}
                  title="Delete document"
                >✕</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── CHUNK SELECTOR ───
function ChunkSelector({ doc, onSelect, onBack }) {
  return (
    <div style={{ padding: "20px 0" }}>
      <button onClick={onBack} style={{ ...btnStyle("transparent", "rgba(0,255,255,0.5)"), padding: "6px 0", border: "none", marginBottom: 16, fontSize: 13 }}>← Back to Library</button>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#e0e8f0", marginBottom: 4 }}>{doc.name}</div>
      <div style={{ fontSize: 12, color: "rgba(180,190,210,0.4)", marginBottom: 6 }}>{doc.totalChunks} section{doc.totalChunks !== 1 ? "s" : ""} • {doc.pages} page{doc.pages !== 1 ? "s" : ""}</div>
      <div style={{ fontSize: 11, color: "rgba(0,255,255,0.25)", marginBottom: 20 }}>Each section is ~5 pages. You can skip lines during a race by clicking ahead.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
        {Array.from({ length: doc.totalChunks }).map((_, i) => {
          const score = doc.chunkScores?.[i];
          const isCompleted = !!score;
          return (
            <div key={i} onClick={() => onSelect(i)}
              style={{
                padding: "16px 12px",
                background: isCompleted ? "rgba(0,255,100,0.05)" : "rgba(0,255,255,0.03)",
                border: `1px solid ${isCompleted ? "rgba(0,255,100,0.2)" : "rgba(0,255,255,0.1)"}`,
                borderRadius: 10, cursor: "pointer", textAlign: "center", transition: "all 0.2s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.03)"; e.currentTarget.style.borderColor = "#0ff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.borderColor = isCompleted ? "rgba(0,255,100,0.2)" : "rgba(0,255,255,0.1)"; }}
            >
              <div style={{ fontSize: 22, fontWeight: 800, color: isCompleted ? "#0f6" : "#0ff", fontFamily: "'Orbitron', sans-serif" }}>{i + 1}</div>
              <div style={{ fontSize: 10, color: "rgba(180,190,210,0.4)", letterSpacing: 1, marginTop: 4 }}>{isCompleted ? `${score.wpm} WPM` : "READY"}</div>
              {isCompleted && (
                <div style={{ marginTop: 4 }}>
                  {[1, 2, 3].map((s) => <span key={s} style={{ fontSize: 10, opacity: s <= score.stars ? 1 : 0.2 }}>⭐</span>)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── MAIN APP ───
export default function DocRacer() {
  const [screen, setScreen] = useState("library");
  const [library, setLibrary] = useState([]);
  const [currentDoc, setCurrentDoc] = useState(null);
  const [currentChunkIdx, setCurrentChunkIdx] = useState(0);
  const [chunkTexts, setChunkTexts] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [loading, setLoading] = useState(true);

  const [raceText, setRaceText] = useState("");
  const [charIndex, setCharIndex] = useState(0);
  const [errors, setErrors] = useState(new Set());
  const [totalErrors, setTotalErrors] = useState(0);
  const [startTime, setStartTime] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [wpm, setWpm] = useState(0);
  const [accuracy, setAccuracy] = useState(100);
  const [streak, setStreak] = useState(0);
  const [nitroActive, setNitroActive] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [raceFinished, setRaceFinished] = useState(false);
  const [skippedRanges, setSkippedRanges] = useState([]);
  const [totalSkipped, setTotalSkipped] = useState(0);
  const [paused, setPaused] = useState(false);

  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const pausedTimeRef = useRef(0); // total ms spent paused

  useEffect(() => { loadLibrary().then((lib) => { setLibrary(lib); setLoading(false); }); }, []);

  useEffect(() => {
    if (screen === "race" && startTime && !raceFinished && !paused) {
      timerRef.current = setInterval(() => {
        const secs = (Date.now() - startTime - pausedTimeRef.current) / 1000;
        setElapsed(secs);
        if (secs > 0) {
          const typedChars = charIndex - totalSkipped;
          setWpm(Math.round((typedChars / 5) / (secs / 60)) || 0);
        }
      }, 200);
      return () => clearInterval(timerRef.current);
    }
  }, [screen, startTime, raceFinished, charIndex, totalSkipped, paused]);

  useEffect(() => {
    if (charIndex > 0) {
      const typed = charIndex - totalSkipped;
      setAccuracy(typed > 0 ? Math.round(((typed - totalErrors) / typed) * 100) : 100);
    }
  }, [charIndex, totalErrors, totalSkipped]);

  useEffect(() => { setNitroActive(streak >= NITRO_STREAK); }, [streak]);

  useEffect(() => {
    if (screen === "countdown") {
      setCountdown(3);
      const iv = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) { clearInterval(iv); setScreen("race"); setStartTime(Date.now()); setTimeout(() => inputRef.current?.focus(), 50); return 0; }
          return c - 1;
        });
      }, 800);
      return () => clearInterval(iv);
    }
  }, [screen]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadError("");
    try {
      const text = await extractText(file);
      if (!text || text.trim().length < 10) throw new Error("Could not extract enough text from this file.");
      const totalPages = Math.max(1, Math.ceil(text.length / CHARS_PER_PAGE));
      if (totalPages > 50) throw new Error("Document exceeds 50 pages. Please upload a shorter document.");
      const chunks = chunkText(text, CHUNK_SIZE * CHARS_PER_PAGE);
      const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const docMeta = { id: docId, name: file.name, pages: totalPages, totalChunks: chunks.length, chunkScores: new Array(chunks.length).fill(null), bestWpm: 0, uploadedAt: Date.now() };
      await saveDocChunks(docId, chunks);
      const newLib = [docMeta, ...library];
      setLibrary(newLib); await saveLibrary(newLib);
    } catch (err) { setUploadError(err.message || "Upload failed"); }
    setUploading(false); e.target.value = "";
  };

  const handleDelete = async (docId) => {
    const newLib = library.filter((d) => d.id !== docId);
    setLibrary(newLib); await saveLibrary(newLib);
    try { await window.storage.delete(`docracer-chunks:${docId}`); } catch {}
  };

  const handleSelectDoc = async (doc) => {
    const chunks = await loadDocChunks(doc.id);
    if (!chunks) { setUploadError("Could not load document chunks"); return; }
    setChunkTexts(chunks); setCurrentDoc(doc); setScreen("chunks");
  };

  const startRace = (chunkIdx) => {
    setCurrentChunkIdx(chunkIdx);
    const cleaned = (chunkTexts[chunkIdx] || "").replace(/\s+/g, " ").trim();
    setRaceText(cleaned); setCharIndex(0); setErrors(new Set()); setTotalErrors(0);
    setStartTime(null); setElapsed(0); setWpm(0); setAccuracy(100);
    setStreak(0); setNitroActive(false); setRaceFinished(false);
    setSkippedRanges([]); setTotalSkipped(0);
    setPaused(false); pausedTimeRef.current = 0;
    setScreen("countdown");
  };

  const pauseStartRef = useRef(null);

  const togglePause = useCallback(() => {
    if (raceFinished) return;
    setPaused((prev) => {
      if (!prev) {
        // Pausing
        pauseStartRef.current = Date.now();
        clearInterval(timerRef.current);
      } else {
        // Resuming
        if (pauseStartRef.current) {
          pausedTimeRef.current += Date.now() - pauseStartRef.current;
          pauseStartRef.current = null;
        }
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      return !prev;
    });
  }, [raceFinished]);

  const handleSkipTo = (targetIdx) => {
    if (targetIdx <= charIndex || raceFinished) return;
    const skippedCount = targetIdx - charIndex;
    setSkippedRanges((prev) => [...prev, { start: charIndex, end: targetIdx }]);
    setTotalSkipped((prev) => prev + skippedCount);
    setCharIndex(targetIdx);
    setStreak(0);
    if (!startTime) setStartTime(Date.now());
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleKeyDown = useCallback((e) => {
    if (screen !== "race" || raceFinished) return;
    // Escape toggles pause
    if (e.key === "Escape") { e.preventDefault(); togglePause(); return; }
    // Block all typing while paused
    if (paused) return;
    if (e.key.length > 1 && e.key !== "Backspace") return;
    e.preventDefault();
    if (e.key === "Backspace") {
      if (charIndex > 0) {
        let newIdx = charIndex - 1;
        for (const r of skippedRanges) {
          if (newIdx >= r.start && newIdx < r.end) { newIdx = r.start - 1; break; }
        }
        if (newIdx >= 0) {
          setCharIndex(newIdx);
          setErrors((prev) => { const n = new Set(prev); n.delete(newIdx); return n; });
        }
      }
      return;
    }
    const expected = raceText[charIndex];
    if (e.key === expected) { setStreak((s) => s + 1); }
    else { setErrors((prev) => new Set(prev).add(charIndex)); setTotalErrors((t) => t + 1); setStreak(0); }
    const newIdx = charIndex + 1;
    setCharIndex(newIdx);
    if (newIdx >= raceText.length) finishRace();
  }, [screen, raceFinished, charIndex, raceText, skippedRanges, paused, togglePause]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const finishRace = async () => {
    setRaceFinished(true); clearInterval(timerRef.current);
    const finalElapsed = (Date.now() - startTime - pausedTimeRef.current) / 1000;
    const typedChars = raceText.length - totalSkipped;
    const finalWpm = Math.round((typedChars / 5) / (finalElapsed / 60)) || 0;
    const finalAcc = typedChars > 0 ? Math.round(((typedChars - totalErrors) / typedChars) * 100) : 100;
    const stars = finalAcc >= 98 && finalWpm >= 60 ? 3 : finalAcc >= 90 && finalWpm >= 30 ? 2 : 1;
    setWpm(finalWpm); setAccuracy(finalAcc); setElapsed(finalElapsed);
    if (currentDoc) {
      const updatedDoc = { ...currentDoc };
      if (!updatedDoc.chunkScores) updatedDoc.chunkScores = [];
      const existing = updatedDoc.chunkScores[currentChunkIdx];
      if (!existing || finalWpm > existing.wpm) {
        updatedDoc.chunkScores[currentChunkIdx] = { wpm: finalWpm, accuracy: finalAcc, stars, time: finalElapsed };
      }
      updatedDoc.bestWpm = Math.max(updatedDoc.bestWpm || 0, finalWpm);
      setCurrentDoc(updatedDoc);
      const newLib = library.map((d) => (d.id === updatedDoc.id ? updatedDoc : d));
      setLibrary(newLib); await saveLibrary(newLib);
    }
    setScreen("results");
  };

  const progress = raceText.length > 0 ? charIndex / raceText.length : 0;

  if (loading) {
    return (
      <div style={{ ...rootStyle, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#0ff", fontFamily: "'Orbitron', sans-serif", fontSize: 18, animation: "pulse 1.5s infinite" }}>LOADING…</div>
      </div>
    );
  }

  return (
    <div style={rootStyle} onClick={() => { if (screen === "race") inputRef.current?.focus(); }}>
      <input ref={inputRef} style={{ position: "absolute", opacity: 0, pointerEvents: "none" }} autoFocus={screen === "race"} />

      <div style={{ textAlign: "center", padding: "18px 0 8px" }}>
        <div style={{
          fontSize: 32, fontWeight: 900, fontFamily: "'Orbitron', sans-serif",
          background: "linear-gradient(90deg, #0ff, #f0f, #0ff)", backgroundSize: "200% 100%",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          animation: "shimmer 3s linear infinite", letterSpacing: 4,
        }}>DOCRACER</div>
        <div style={{ fontSize: 11, letterSpacing: 4, color: "rgba(180,190,210,0.3)", marginTop: 2 }}>LEARN BY TYPING • SKIP WHAT YOU KNOW</div>
      </div>

      {screen === "library" && (
        <Library library={library} onSelect={handleSelectDoc} onUpload={handleUpload}
          uploading={uploading} uploadError={uploadError} onDelete={handleDelete} />
      )}

      {screen === "chunks" && currentDoc && (
        <ChunkSelector doc={currentDoc} onSelect={startRace} onBack={() => setScreen("library")} />
      )}

      {screen === "countdown" && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300 }}>
          <div style={{
            fontSize: 120, fontWeight: 900, fontFamily: "'Orbitron', sans-serif", color: "#0ff",
            textShadow: "0 0 40px rgba(0,255,255,0.5), 0 0 80px rgba(0,255,255,0.2)",
            animation: "countPulse 0.8s ease-in-out infinite",
          }}>{countdown}</div>
        </div>
      )}

      {screen === "race" && (
        <div style={{ position: "relative" }}>
          {/* Pause button */}
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 4px 4px" }}>
            <button onClick={togglePause} style={{
              ...btnStyle("rgba(255,255,255,0.05)", "rgba(180,190,210,0.5)"),
              padding: "6px 16px", fontSize: 12, borderRadius: 6,
            }}>
              {paused ? "▶ RESUME" : "⏸ PAUSE"} <span style={{ opacity: 0.4, marginLeft: 6, fontSize: 10 }}>ESC</span>
            </button>
          </div>

          <Racetrack progress={progress} nitroActive={nitroActive} />
          <StatsBar wpm={wpm} accuracy={accuracy} elapsed={elapsed} progress={progress} skippedCount={totalSkipped} />
          <TypingDisplay text={raceText} currentIndex={charIndex} errors={errors}
            skippedRanges={skippedRanges} onSkipToLine={handleSkipTo} />
          {nitroActive && !paused && (
            <div style={{ textAlign: "center", marginTop: 8, fontSize: 12, color: "#f0f", letterSpacing: 4, fontWeight: 700, textShadow: "0 0 10px #f0f", animation: "pulse 0.5s infinite" }}>
              ⚡ NITRO ACTIVE ⚡
            </div>
          )}
          <div style={{ textAlign: "center", marginTop: 10, fontSize: 12, color: "rgba(180,190,210,0.25)" }}>
            Section {currentChunkIdx + 1} of {currentDoc?.totalChunks || 1} • Click anywhere to focus
          </div>

          {/* Pause overlay */}
          {paused && (
            <div style={{
              position: "absolute", inset: 0, background: "rgba(8,8,15,0.88)",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              borderRadius: 12, zIndex: 20, backdropFilter: "blur(6px)",
            }}>
              <div style={{
                fontSize: 48, fontWeight: 900, fontFamily: "'Orbitron', sans-serif",
                color: "#0ff", textShadow: "0 0 30px rgba(0,255,255,0.4)",
                marginBottom: 12, animation: "pulse 2s infinite",
              }}>PAUSED</div>
              <div style={{ fontSize: 13, color: "rgba(180,190,210,0.4)", marginBottom: 28, letterSpacing: 2 }}>
                Press <span style={{ color: "#0ff", fontWeight: 700 }}>ESC</span> or click below to resume
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <button onClick={togglePause} style={btnStyle("rgba(0,255,255,0.15)", "#0ff")}>▶ RESUME</button>
                <button onClick={() => { setPaused(false); setScreen("chunks"); }} style={btnStyle("#222", "rgba(255,51,102,0.6)")}>✕ QUIT</button>
              </div>
            </div>
          )}
        </div>
      )}

      {screen === "results" && (
        <ResultsScreen wpm={wpm} accuracy={accuracy} time={elapsed} errors={totalErrors}
          skipped={totalSkipped}
          hasNext={currentDoc && currentChunkIdx < currentDoc.totalChunks - 1}
          onNext={() => startRace(currentChunkIdx + 1)}
          onReplay={() => startRace(currentChunkIdx)}
          onLibrary={() => setScreen("chunks")} />
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:wght@400;600;700&display=swap');
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes countPulse { 0% { transform: scale(1); } 50% { transform: scale(1.15); } 100% { transform: scale(1); } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(0,255,255,0.15); border-radius: 3px; }
      `}</style>
    </div>
  );
}

const rootStyle = {
  minHeight: "100vh",
  background: "linear-gradient(160deg, #08080f 0%, #0a0e1a 40%, #0d0a18 100%)",
  color: "#e0e8f0",
  fontFamily: "'JetBrains Mono', monospace",
  padding: "0 20px 40px",
  maxWidth: 800,
  margin: "0 auto",
  position: "relative",
  overflow: "hidden",
};
