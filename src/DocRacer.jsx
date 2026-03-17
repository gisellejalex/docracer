import { useState, useEffect, useRef, useCallback } from "react";
import JSZip from "jszip";

// ─── CONSTANTS ───
const CHUNK_SIZE = 1; // ~1 page per section (smaller for learning)
const CHARS_PER_PAGE = 2000;
const NITRO_STREAK = 10;
const LINE_CHAR_WIDTH = 52;
const QUIZ_QUESTIONS_PER_SECTION = 5;

// ─── Load PDF.js from CDN ───
let pdfjsReady = null;
function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const s2 = document.createElement("script");
    s2.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.js";
    s2.onload = () => {
      const lib = window.pdfjsLib;
      if (lib) {
        lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.js";
        resolve(lib);
      } else reject(new Error("PDF.js failed to load"));
    };
    s2.onerror = () => reject(new Error("Could not load PDF.js"));
    document.head.appendChild(s2);
  });
  return pdfjsReady;
}

// ─── FILE PARSERS ───
async function parseDocx(ab) {
  const zip = await JSZip.loadAsync(ab);
  const f = zip.file("word/document.xml");
  if (!f) throw new Error("Invalid DOCX.");
  const xml = await f.async("string");
  return xml.replace(/<w:p[^>]*\/>/g,"\n").replace(/<w:p[ >]/g,"\n<w:p ").replace(/<w:tab\/>/g," ")
    .replace(/<w:br[^>]*\/>/g,"\n").replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<")
    .replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/\n{3,}/g,"\n\n").trim();
}
async function parsePdf(ab) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({data:ab}).promise;
  const parts = [];
  for (let i=1;i<=pdf.numPages;i++){const p=await pdf.getPage(i);const c=await p.getTextContent();parts.push(c.items.map(x=>x.str).join(" "));}
  const t = parts.join("\n\n").replace(/\s+/g," ").trim();
  if(t.length<10) throw new Error("Could not extract text from PDF.");
  return t;
}
function parseRtf(t){return t.replace(/\\par[d]?/g,"\n").replace(/\\tab/g," ").replace(/\\line/g,"\n").replace(/\\'([0-9a-fA-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16))).replace(/\\[a-z]+\d*\s?/gi,"").replace(/[{}]/g,"").replace(/\n{3,}/g,"\n\n").trim();}
function parseHtml(t){return(new DOMParser().parseFromString(t,"text/html").body.textContent||"").replace(/\s+/g," ").trim();}
async function extractText(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if(["txt","md","csv","tsv","log","json","xml","yml","yaml","ini","cfg"].includes(ext)) return await file.text();
  if(ext==="docx") return await parseDocx(await file.arrayBuffer());
  if(ext==="pdf") return await parsePdf(await file.arrayBuffer());
  if(ext==="rtf") return parseRtf(await file.text());
  if(ext==="html"||ext==="htm") return parseHtml(await file.text());
  if(ext==="doc"){
    const b=new Uint8Array(await file.arrayBuffer());let t="";
    for(let i=0;i<b.length;i++){const c=b[i];if(c>=32&&c<127)t+=String.fromCharCode(c);else if(c===13||c===10)t+="\n";else t+=" ";}
    t=t.replace(/[^\S\n]+/g," ").replace(/\n{3,}/g,"\n\n").trim();
    const lines=t.split("\n").filter(l=>{const p=l.replace(/[^a-zA-Z0-9 .,;:!?'"()\-]/g,"");return p.length>l.length*0.5;});
    t=lines.join("\n").trim();if(t.length<20)throw new Error("Could not extract .doc text.");return t;
  }
  throw new Error(`Unsupported: .${ext}`);
}
function chunkText(text, chunkCharSize) {
  const chunks=[];let i=0;
  while(i<text.length){let end=Math.min(i+chunkCharSize,text.length);
    if(end<text.length){const lp=text.lastIndexOf(". ",end);const ls=text.lastIndexOf(" ",end);
      if(lp>i+chunkCharSize*0.7)end=lp+1;else if(ls>i+chunkCharSize*0.5)end=ls;}
    const chunk=text.slice(i,end).trim();if(chunk.length>0)chunks.push(chunk);i=end;}
  return chunks;
}
function textToLines(text) {
  const lines=[];let ls=0,col=0,lsp=-1;
  for(let i=0;i<text.length;i++){if(text[i]===" ")lsp=i;col++;
    if(col>=LINE_CHAR_WIDTH&&lsp>ls){lines.push({start:ls,end:lsp+1});ls=lsp+1;col=i-lsp;lsp=-1;}}
  if(ls<text.length)lines.push({start:ls,end:text.length});return lines;
}

// ─── QUIZ GENERATION ───
function generateQuiz(text, numQuestions = QUIZ_QUESTIONS_PER_SECTION) {
  // Extract sentences
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const goodSentences = sentences
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).length >= 6 && s.split(/\s+/).length <= 40);
  
  if (goodSentences.length === 0) return [];

  const shuffled = [...goodSentences].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(numQuestions * 2, shuffled.length));
  const questions = [];

  // Extract meaningful words (not common stop words) for distractors
  const allWords = text.match(/\b[A-Za-z][a-z]{3,}\b/g) || [];
  const wordSet = [...new Set(allWords)];

  for (let i = 0; i < selected.length && questions.length < numQuestions; i++) {
    const sentence = selected[i];
    const words = sentence.split(/\s+/);
    
    // Pick a content word to blank out (skip first/last, skip short words)
    const candidates = [];
    for (let w = 1; w < words.length - 1; w++) {
      const clean = words[w].replace(/[^a-zA-Z]/g, "");
      if (clean.length >= 4 && !isStopWord(clean.toLowerCase())) {
        candidates.push({ idx: w, word: clean });
      }
    }
    if (candidates.length === 0) continue;

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    const blankedSentence = words.map((w, idx) => idx === chosen.idx ? "________" : w).join(" ");

    // Generate distractors from document words
    const distractors = wordSet
      .filter(w => w.toLowerCase() !== chosen.word.toLowerCase() && Math.abs(w.length - chosen.word.length) <= 3)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    // If not enough distractors, generate some
    while (distractors.length < 3) {
      const fake = shuffleWord(chosen.word);
      if (fake !== chosen.word && !distractors.includes(fake)) distractors.push(fake);
    }

    const options = [chosen.word, ...distractors.slice(0, 3)].sort(() => Math.random() - 0.5);

    questions.push({
      type: "fill",
      sentence: blankedSentence,
      fullSentence: sentence,
      answer: chosen.word,
      options,
    });
  }

  return questions;
}

function isStopWord(w) {
  const stops = new Set(["the","and","that","this","with","from","they","been","have","were","was","are","but","not","you","all","can","had","her","his","one","our","out","for","its","also","then","than","them","into","some","when","will","more","very","just","about","would","could","should","there","their","which","these","those","other","after","before","being","most","only","over","such","what","where","while"]);
  return stops.has(w);
}

function shuffleWord(word) {
  const arr = word.split("");
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}

// ─── STORAGE ───
async function loadLibrary(){try{const r=await window.storage.get("docracer-library");return r?JSON.parse(r.value):[];}catch{return[];}}
async function saveLibrary(lib){try{await window.storage.set("docracer-library",JSON.stringify(lib));}catch(e){console.error(e);}}
async function loadDocChunks(id){try{const r=await window.storage.get(`docracer-chunks:${id}`);return r?JSON.parse(r.value):null;}catch{return null;}}
async function saveDocChunks(id,chunks){try{await window.storage.set(`docracer-chunks:${id}`,JSON.stringify(chunks));}catch(e){console.error(e);}}

// ─── COMPONENTS ───
function NeonCar({nitroActive,color="#0ff"}){
  return(<svg width="80" height="36" viewBox="0 0 80 36" style={{filter:nitroActive?`drop-shadow(0 0 12px ${color}) drop-shadow(0 0 24px ${color})`:`drop-shadow(0 0 4px ${color})`,transition:"filter 0.3s"}}>
    <rect x="8" y="12" width="60" height="16" rx="4" fill="transparent" stroke={color} strokeWidth="1.5"/>
    <rect x="22" y="6" width="30" height="12" rx="3" fill="transparent" stroke={color} strokeWidth="1.5"/>
    <line x1="32" y1="6" x2="32" y2="18" stroke={color} strokeWidth="1" opacity="0.5"/>
    <circle cx="20" cy="30" r="5" fill="transparent" stroke={color} strokeWidth="1.5"/><circle cx="58" cy="30" r="5" fill="transparent" stroke={color} strokeWidth="1.5"/>
    <circle cx="20" cy="30" r="2" fill={color} opacity="0.6"/><circle cx="58" cy="30" r="2" fill={color} opacity="0.6"/>
    {nitroActive&&<><line x1="2" y1="20" x2="-12" y2="18" stroke="#f0f" strokeWidth="2" opacity="0.9"><animate attributeName="x2" values="-12;-20;-12" dur="0.2s" repeatCount="indefinite"/></line>
    <line x1="2" y1="24" x2="-16" y2="26" stroke="#f0f" strokeWidth="1.5" opacity="0.7"><animate attributeName="x2" values="-16;-24;-16" dur="0.15s" repeatCount="indefinite"/></line></>}
  </svg>);
}
function Racetrack({progress,nitroActive}){
  const w=700,cx=Math.min(progress,1)*(w-90);
  return(<div style={{position:"relative",width:"100%",maxWidth:740,margin:"0 auto",padding:"18px 20px 10px"}}>
    <div style={{position:"relative",height:56,borderRadius:28,background:"linear-gradient(90deg,rgba(0,255,255,0.04),rgba(255,0,255,0.06))",border:"1px solid rgba(0,255,255,0.15)",overflow:"hidden"}}>
      <div style={{position:"absolute",top:"50%",left:0,right:0,height:1,background:"repeating-linear-gradient(90deg,rgba(0,255,255,0.2) 0px,rgba(0,255,255,0.2) 12px,transparent 12px,transparent 28px)"}}/>
      <div style={{position:"absolute",top:0,left:0,width:`${progress*100}%`,height:"100%",background:"linear-gradient(90deg,transparent,rgba(0,255,255,0.08),rgba(255,0,255,0.1))",transition:"width 0.15s"}}/>
      <div style={{position:"absolute",left:cx,top:10,transition:"left 0.15s ease-out"}}><NeonCar nitroActive={nitroActive}/></div>
    </div><div style={{position:"absolute",right:16,top:8,fontSize:20,opacity:0.5}}>🏁</div></div>);
}

function TypingDisplay({text,currentIndex,errors,skippedRanges,onSkipToLine,darkMode=true,zenMode=false}){
  const containerRef=useRef(null),cursorRef=useRef(null);
  const[hoveredLine,setHoveredLine]=useState(-1),[confirmLine,setConfirmLine]=useState(-1);
  const lines=textToLines(text);
  useEffect(()=>{if(cursorRef.current&&containerRef.current){const c=containerRef.current,cu=cursorRef.current;const cr=c.getBoundingClientRect(),cur=cu.getBoundingClientRect();const rt=cur.top-cr.top;if(rt>cr.height*0.55||rt<0)c.scrollTop+=rt-cr.height*0.3;}},[currentIndex]);
  useEffect(()=>{setConfirmLine(-1);},[currentIndex]);
  const isSkipped=(idx)=>{for(const r of skippedRanges)if(idx>=r.start&&idx<r.end)return true;return false;};
  const handleLineClick=(li,e)=>{e.stopPropagation();const line=lines[li];if(line.start<=currentIndex)return;if(confirmLine===li){onSkipToLine(line.start);setConfirmLine(-1);}else setConfirmLine(li);};
  return(<div style={{position:"relative"}}>
    <div ref={containerRef} style={{fontFamily:"'JetBrains Mono','Fira Code',monospace",fontSize:17,lineHeight:2.1,padding:"20px 24px 20px 44px",background:darkMode?"rgba(0,0,0,0.5)":"rgba(255,255,255,0.7)",border:`1px solid ${darkMode?"rgba(0,255,255,0.12)":"rgba(0,120,140,0.2)"}`,borderRadius:12,height:260,overflowY:"auto",overflowX:"hidden",wordBreak:"break-word",whiteSpace:"pre-wrap",scrollBehavior:"smooth",position:"relative"}}>
      {lines.map((line,li)=>{const lc=text.slice(line.start,line.end),isAhead=line.start>currentIndex,isH=hoveredLine===li&&isAhead,isC=confirmLine===li,isCur=currentIndex>=line.start&&currentIndex<line.end;
        return(<div key={li} onClick={e=>handleLineClick(li,e)} onMouseEnter={()=>isAhead&&setHoveredLine(li)} onMouseLeave={()=>setHoveredLine(-1)}
          style={{position:"relative",cursor:isAhead?"pointer":"default",background:isC?"rgba(255,0,255,0.08)":isH?"rgba(0,255,255,0.04)":"transparent",borderRadius:4,margin:"0 -8px",padding:"0 8px",transition:"background 0.15s",borderLeft:isCur?"3px solid #0ff":"3px solid transparent",paddingLeft:isCur?5:8}}>
          <span style={{position:"absolute",left:-34,top:0,fontSize:10,color:isCur?"rgba(0,255,255,0.5)":"rgba(180,190,210,0.15)",fontWeight:600,lineHeight:"2.1em",width:24,textAlign:"right",userSelect:"none",fontFamily:"'Orbitron',sans-serif"}}>{li+1}</span>
          {isC&&<span style={{position:"absolute",right:4,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"#f0f",background:"rgba(255,0,255,0.15)",border:"1px solid rgba(255,0,255,0.3)",borderRadius:4,padding:"2px 8px",letterSpacing:1,fontWeight:700,zIndex:5,whiteSpace:"nowrap",pointerEvents:"none",animation:"pulse 1s infinite"}}>CLICK AGAIN TO SKIP HERE</span>}
          {isH&&!isC&&<span style={{position:"absolute",right:4,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"rgba(0,255,255,0.5)",letterSpacing:1,fontWeight:600,zIndex:5,whiteSpace:"nowrap",pointerEvents:"none"}}>⏭ SKIP TO LINE</span>}
          {lc.split("").map((char,ci)=>{const gi=line.start+ci,sk=isSkipped(gi),er=errors.has(gi),tp=gi<currentIndex,ic=gi===currentIndex;
            let col="rgba(180,190,210,0.35)",bg="transparent";if(sk)col="rgba(180,190,210,0.12)";else if(tp&&!er)col="#0ff";else if(tp&&er){col=zenMode?"#0ff":"#ff3366";bg=zenMode?"transparent":"rgba(255,51,102,0.15)";}if(ic)bg="rgba(0,255,255,0.15)";
            return(<span key={ci} ref={ic?cursorRef:null} style={{color:col,background:bg,borderBottom:ic?"2px solid #0ff":"none",transition:"color 0.1s",textShadow:tp&&!er&&!sk?"0 0 8px rgba(0,255,255,0.4)":"none",textDecoration:sk?"line-through":"none",textDecorationColor:"rgba(180,190,210,0.15)"}}>{char}</span>);})}
        </div>);})}
    </div>
    <div style={{display:"flex",gap:16,justifyContent:"center",marginTop:8,flexWrap:"wrap",fontSize:10,color:"rgba(180,190,210,0.3)"}}>
      <span>🖱️ Click a line ahead to skip</span><span><span style={{color:"#0ff"}}>●</span> Typed</span>{!zenMode&&<span><span style={{color:"#f36"}}>●</span> Error</span>}<span style={{textDecoration:"line-through",textDecorationColor:"rgba(180,190,210,0.2)"}}>Skipped</span>
    </div></div>);
}

function StatsBar({wpm,accuracy,elapsed,progress,skippedCount,showTime=true,T,zenMode=false}){
  const fmt=s=>`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;
  const accColor = zenMode ? T.accent : (accuracy>=95?T.success:accuracy>=85?T.warn:T.error);
  const stats = [{label:"WPM",value:wpm,color:T.accent},{label:"ACCURACY",value:`${accuracy}%`,color:accColor},...(showTime?[{label:"TIME",value:fmt(elapsed),color:"#c8f"}]:[]),{label:"PROGRESS",value:`${Math.round(progress*100)}%`,color:"#f90"},...(skippedCount>0?[{label:"SKIPPED",value:skippedCount,color:T.textMuted}]:[])];
  return(<div style={{display:"flex",gap:20,justifyContent:"center",flexWrap:"wrap",padding:"12px 0"}}>
    {stats.map(s=>
      <div key={s.label} style={{textAlign:"center",minWidth:68}}><div style={{fontSize:10,letterSpacing:2,color:T.textMuted,fontWeight:600,marginBottom:3}}>{s.label}</div>
      <div style={{fontSize:24,fontWeight:800,color:s.color,textShadow:`0 0 12px ${s.color}44`,fontFamily:"'Orbitron',sans-serif"}}>{s.value}</div></div>)}
  </div>);
}

const btnStyle=(bg,color)=>({padding:"12px 28px",background:bg,color,border:`1px solid ${color}33`,borderRadius:8,fontSize:14,fontWeight:700,cursor:"pointer",letterSpacing:1,fontFamily:"'Orbitron','JetBrains Mono',monospace",transition:"all 0.2s"});

// ─── RESULTS SCREEN (updated with quiz button) ───
function ResultsScreen({wpm,accuracy,time,errors,skipped,onNext,onReplay,onLibrary,onQuiz,hasNext,isReviewRace}){
  const stars=accuracy>=98&&wpm>=60?3:accuracy>=90&&wpm>=30?2:1;
  return(<div style={{textAlign:"center",padding:"40px 20px"}}>
    <div style={{fontSize:14,letterSpacing:6,color:isReviewRace?"rgba(255,0,255,0.5)":"rgba(0,255,255,0.5)",marginBottom:8}}>{isReviewRace?"REVIEW COMPLETE":"RACE COMPLETE"}</div>
    <div style={{fontSize:48,marginBottom:24}}>{[1,2,3].map(s=><span key={s} style={{fontSize:48,margin:"0 4px",filter:s<=stars?"drop-shadow(0 0 8px #ff0)":"grayscale(1) opacity(0.3)"}}>⭐</span>)}</div>
    <div style={{display:"flex",gap:28,justifyContent:"center",flexWrap:"wrap",marginBottom:32}}>
      {[{label:"WPM",value:wpm,color:"#0ff"},{label:"ACCURACY",value:`${accuracy}%`,color:"#0f6"},{label:"TIME",value:`${Math.floor(time/60)}m ${Math.floor(time%60)}s`,color:"#c8f"},{label:"ERRORS",value:errors,color:"#f36"},...(skipped>0?[{label:"SKIPPED",value:`${skipped}`,color:"rgba(180,190,210,0.4)"}]:[])].map(s=>
        <div key={s.label} style={{minWidth:80}}><div style={{fontSize:10,letterSpacing:2,color:"rgba(180,190,210,0.4)",marginBottom:5}}>{s.label}</div>
        <div style={{fontSize:28,fontWeight:800,color:s.color,fontFamily:"'Orbitron',sans-serif",textShadow:`0 0 10px ${s.color}44`}}>{s.value}</div></div>)}
    </div>
    <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
      <button onClick={onReplay} style={btnStyle("#333","#0ff")}>↻ Replay</button>
      {!isReviewRace && onQuiz && <button onClick={onQuiz} style={btnStyle("rgba(255,0,255,0.15)","#f0f")}>📝 Take Quiz</button>}
      {hasNext&&<button onClick={onNext} style={btnStyle("rgba(0,255,255,0.15)","#0ff")}>Next Section →</button>}
      <button onClick={onLibrary} style={btnStyle("#222","#888")}>Sections</button>
    </div>
  </div>);
}

// ─── QUIZ SCREEN ───
function QuizScreen({ questions, onFinish }) {
  const [currentQ, setCurrentQ] = useState(0);
  const [selected, setSelected] = useState(null);
  const [showResult, setShowResult] = useState(false);
  const [results, setResults] = useState([]); // {question, selectedAnswer, correct, correctAnswer}

  if (questions.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px" }}>
        <div style={{ fontSize: 18, color: "rgba(180,190,210,0.5)", marginBottom: 20 }}>Not enough content to generate a quiz for this section.</div>
        <button onClick={() => onFinish([])} style={btnStyle("#333", "#0ff")}>← Back</button>
      </div>
    );
  }

  const q = questions[currentQ];
  const isLast = currentQ >= questions.length - 1;

  const handleSelect = (option) => {
    if (showResult) return;
    setSelected(option);
    setShowResult(true);
    const correct = option.toLowerCase() === q.answer.toLowerCase();
    setResults(prev => [...prev, { question: q, selectedAnswer: option, correct, correctAnswer: q.answer }]);
  };

  const handleNext = () => {
    if (isLast) {
      onFinish(results.concat(showResult ? [] : [])); // results already updated in handleSelect
      return;
    }
    setCurrentQ(prev => prev + 1);
    setSelected(null);
    setShowResult(false);
  };

  return (
    <div style={{ padding: "20px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 14, letterSpacing: 4, color: "rgba(255,0,255,0.5)", fontWeight: 700 }}>📝 QUIZ</div>
        <div style={{ fontSize: 12, color: "rgba(180,190,210,0.4)" }}>
          {currentQ + 1} / {questions.length}
        </div>
      </div>

      {/* Progress dots */}
      <div style={{ display: "flex", gap: 6, marginBottom: 24, justifyContent: "center" }}>
        {questions.map((_, i) => {
          const r = results[i];
          let dotColor = "rgba(180,190,210,0.15)";
          if (r) dotColor = r.correct ? "#0f6" : "#f36";
          if (i === currentQ && !showResult) dotColor = "#0ff";
          return <div key={i} style={{ width: 10, height: 10, borderRadius: 5, background: dotColor, transition: "background 0.3s" }} />;
        })}
      </div>

      {/* Question */}
      <div style={{
        padding: "24px", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,0,255,0.12)",
        borderRadius: 12, marginBottom: 20, fontSize: 15, lineHeight: 1.8, color: "#e0e8f0",
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        <div style={{ fontSize: 11, letterSpacing: 2, color: "rgba(255,0,255,0.4)", marginBottom: 12, fontWeight: 600 }}>FILL IN THE BLANK</div>
        {q.sentence}
      </div>

      {/* Options */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
        {q.options.map((opt, oi) => {
          const isCorrectOpt = opt.toLowerCase() === q.answer.toLowerCase();
          const isSelected = selected === opt;
          let bg = "rgba(0,255,255,0.04)";
          let border = "rgba(0,255,255,0.12)";
          let col = "#e0e8f0";
          if (showResult) {
            if (isCorrectOpt) { bg = "rgba(0,255,100,0.1)"; border = "#0f6"; col = "#0f6"; }
            else if (isSelected && !isCorrectOpt) { bg = "rgba(255,51,102,0.1)"; border = "#f36"; col = "#f36"; }
            else { bg = "rgba(0,0,0,0.2)"; border = "rgba(180,190,210,0.05)"; col = "rgba(180,190,210,0.3)"; }
          }
          return (
            <div key={oi} onClick={() => handleSelect(opt)}
              style={{
                padding: "14px 16px", background: bg, border: `1px solid ${border}`,
                borderRadius: 10, cursor: showResult ? "default" : "pointer",
                fontSize: 14, fontWeight: 600, color: col, textAlign: "center",
                transition: "all 0.2s", fontFamily: "'JetBrains Mono', monospace",
              }}
              onMouseEnter={e => { if (!showResult) { e.currentTarget.style.borderColor = "#0ff"; e.currentTarget.style.background = "rgba(0,255,255,0.08)"; } }}
              onMouseLeave={e => { if (!showResult) { e.currentTarget.style.borderColor = "rgba(0,255,255,0.12)"; e.currentTarget.style.background = "rgba(0,255,255,0.04)"; } }}
            >
              {opt}
            </div>
          );
        })}
      </div>

      {/* Correct answer context */}
      {showResult && (
        <div style={{ padding: "16px", background: "rgba(0,0,0,0.3)", borderRadius: 8, marginBottom: 16, fontSize: 12, color: "rgba(180,190,210,0.5)", lineHeight: 1.7 }}>
          <span style={{ color: "#0f6", fontWeight: 700 }}>Answer: {q.answer}</span>
          <div style={{ marginTop: 6, fontStyle: "italic", opacity: 0.7 }}>"{q.fullSentence.trim()}"</div>
        </div>
      )}

      {showResult && (
        <div style={{ textAlign: "center" }}>
          <button onClick={handleNext} style={btnStyle("rgba(0,255,255,0.15)", "#0ff")}>
            {isLast ? "See Results →" : "Next Question →"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── QUIZ RESULTS SCREEN ───
function QuizResultsScreen({ results, onReviewRace, onBack }) {
  const correct = results.filter(r => r.correct).length;
  const total = results.length;
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  const wrong = results.filter(r => !r.correct);

  return (
    <div style={{ padding: "20px 0", textAlign: "center" }}>
      <div style={{ fontSize: 14, letterSpacing: 6, color: "rgba(255,0,255,0.5)", marginBottom: 16 }}>QUIZ RESULTS</div>
      <div style={{ fontSize: 64, fontWeight: 900, fontFamily: "'Orbitron', sans-serif", color: pct >= 80 ? "#0f6" : pct >= 50 ? "#ff0" : "#f36", textShadow: `0 0 20px ${pct >= 80 ? "rgba(0,255,100,0.3)" : "rgba(255,51,102,0.3)"}`, marginBottom: 8 }}>
        {pct}%
      </div>
      <div style={{ fontSize: 14, color: "rgba(180,190,210,0.5)", marginBottom: 24 }}>
        {correct} of {total} correct
      </div>

      {/* Wrong answers list */}
      {wrong.length > 0 && (
        <div style={{ textAlign: "left", marginBottom: 24 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: "rgba(255,51,102,0.5)", fontWeight: 600, marginBottom: 10 }}>MISSED QUESTIONS</div>
          {wrong.map((r, i) => (
            <div key={i} style={{ padding: "12px 16px", background: "rgba(255,51,102,0.04)", border: "1px solid rgba(255,51,102,0.1)", borderRadius: 8, marginBottom: 8, fontSize: 13, lineHeight: 1.6 }}>
              <div style={{ color: "rgba(180,190,210,0.6)" }}>{r.question.sentence}</div>
              <div style={{ marginTop: 4 }}>
                <span style={{ color: "#f36", textDecoration: "line-through", opacity: 0.7 }}>{r.selectedAnswer}</span>
                <span style={{ margin: "0 8px", color: "rgba(180,190,210,0.3)" }}>→</span>
                <span style={{ color: "#0f6", fontWeight: 700 }}>{r.correctAnswer}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        {wrong.length > 0 && (
          <button onClick={() => onReviewRace(wrong)} style={btnStyle("rgba(255,0,255,0.15)", "#f0f")}>
            🏎️ Review Race ({wrong.length} missed)
          </button>
        )}
        <button onClick={onBack} style={btnStyle("#222", "#888")}>← Back to Sections</button>
      </div>
    </div>
  );
}

// ─── LIBRARY ───
function Library({library,onSelect,onUpload,uploading,uploadError,onDelete}){
  return(<div style={{padding:"20px 0"}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24,flexWrap:"wrap",gap:12}}>
      <div><div style={{fontSize:14,letterSpacing:6,color:"rgba(0,255,255,0.4)",fontWeight:600}}>DOCUMENT LIBRARY</div>
        <div style={{fontSize:11,color:"rgba(180,190,210,0.25)",marginTop:4}}>Upload study materials • type to learn • quiz yourself</div></div>
      <label style={{...btnStyle("rgba(0,255,255,0.1)","#0ff"),display:"inline-flex",alignItems:"center",gap:8,position:"relative"}}>
        {uploading?"Processing…":"＋ Upload Document"}
        <input type="file" accept=".txt,.md,.docx,.doc,.pdf,.rtf,.html,.htm,.csv,.tsv,.log,.json,.xml,.yml,.yaml" onChange={onUpload} disabled={uploading} style={{position:"absolute",inset:0,opacity:0,cursor:"pointer"}}/>
      </label></div>
    {uploadError&&<div style={{color:"#f36",marginBottom:16,fontSize:13}}>{uploadError}</div>}
    {library.length===0?(<div style={{textAlign:"center",padding:"60px 20px"}}><div style={{fontSize:48,marginBottom:16,opacity:0.3}}>📄</div>
      <div style={{color:"rgba(180,190,210,0.4)",fontSize:15,maxWidth:380,margin:"0 auto",lineHeight:1.7}}>
        Upload a document to start learning.<br/>Supports PDF, DOCX, DOC, RTF, TXT, HTML, and more.<br/>
        <span style={{color:"rgba(0,255,255,0.3)",fontSize:12}}>Each section is ~1 page. Take a quiz after typing to test retention!</span></div></div>
    ):(
      <div style={{display:"grid",gap:12}}>{library.map(doc=>{const comp=doc.chunkScores?doc.chunkScores.filter(Boolean).length:0;const tot=doc.totalChunks;const pct=tot>0?Math.round((comp/tot)*100):0;
        return(<div key={doc.id} style={{display:"flex",alignItems:"stretch",gap:0}}>
          <div onClick={()=>onSelect(doc)} style={{flex:1,padding:"16px 20px",background:"rgba(0,255,255,0.03)",border:"1px solid rgba(0,255,255,0.1)",borderRadius:"10px 0 0 10px",cursor:"pointer",transition:"all 0.2s",display:"flex",alignItems:"center",gap:16}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(0,255,255,0.35)";e.currentTarget.style.background="rgba(0,255,255,0.06)";}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(0,255,255,0.1)";e.currentTarget.style.background="rgba(0,255,255,0.03)";}}>
            <div style={{fontSize:28,opacity:0.5}}>📄</div>
            <div style={{flex:1,minWidth:0}}><div style={{fontSize:15,fontWeight:700,color:"#e0e8f0",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{doc.name}</div>
              <div style={{fontSize:12,color:"rgba(180,190,210,0.4)"}}>{tot} section{tot!==1?"s":""} • {doc.pages} pg{doc.pages!==1?"s":""}{doc.bestWpm?` • Best: ${doc.bestWpm} WPM`:""}</div></div>
            <div style={{minWidth:56,textAlign:"right"}}><div style={{fontSize:18,fontWeight:800,color:pct===100?"#0f6":"#0ff",fontFamily:"'Orbitron',sans-serif"}}>{pct}%</div>
              <div style={{fontSize:10,color:"rgba(180,190,210,0.3)",letterSpacing:1}}>{comp}/{tot}</div></div>
          </div>
          <button onClick={e=>{e.stopPropagation();onDelete(doc.id);}} style={{background:"rgba(255,51,102,0.06)",border:"1px solid rgba(255,51,102,0.15)",borderLeft:"none",borderRadius:"0 10px 10px 0",color:"rgba(255,51,102,0.4)",cursor:"pointer",padding:"0 14px",fontSize:16,transition:"all 0.2s",display:"flex",alignItems:"center"}}
            onMouseEnter={e=>{e.currentTarget.style.color="#f36";e.currentTarget.style.background="rgba(255,51,102,0.12)";}}
            onMouseLeave={e=>{e.currentTarget.style.color="rgba(255,51,102,0.4)";e.currentTarget.style.background="rgba(255,51,102,0.06)";}}>✕</button>
        </div>);})}</div>)}
  </div>);
}

function ChunkSelector({doc,onSelect,onBack,onQuizAll}){
  return(<div style={{padding:"20px 0"}}>
    <button onClick={onBack} style={{...btnStyle("transparent","rgba(0,255,255,0.5)"),padding:"6px 0",border:"none",marginBottom:16,fontSize:13}}>← Back to Library</button>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:6}}>
      <div style={{fontSize:18,fontWeight:700,color:"#e0e8f0"}}>{doc.name}</div>
      <button onClick={onQuizAll} style={{...btnStyle("rgba(255,0,255,0.1)","#f0f"),padding:"8px 18px",fontSize:12}}>📝 Quiz All</button>
    </div>
    <div style={{fontSize:12,color:"rgba(180,190,210,0.4)",marginBottom:6}}>{doc.totalChunks} section{doc.totalChunks!==1?"s":""} • {doc.pages} pg{doc.pages!==1?"s":""}</div>
    <div style={{fontSize:11,color:"rgba(0,255,255,0.25)",marginBottom:20}}>~1 page each. Click a section to race, then quiz yourself after!</div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:10}}>
      {Array.from({length:doc.totalChunks}).map((_,i)=>{const score=doc.chunkScores?.[i];const isC=!!score;
        return(<div key={i} onClick={()=>onSelect(i)} style={{padding:"14px 10px",background:isC?"rgba(0,255,100,0.05)":"rgba(0,255,255,0.03)",border:`1px solid ${isC?"rgba(0,255,100,0.2)":"rgba(0,255,255,0.1)"}`,borderRadius:10,cursor:"pointer",textAlign:"center",transition:"all 0.2s"}}
          onMouseEnter={e=>{e.currentTarget.style.transform="scale(1.03)";e.currentTarget.style.borderColor="#0ff";}}
          onMouseLeave={e=>{e.currentTarget.style.transform="scale(1)";e.currentTarget.style.borderColor=isC?"rgba(0,255,100,0.2)":"rgba(0,255,255,0.1)";}}>
          <div style={{fontSize:20,fontWeight:800,color:isC?"#0f6":"#0ff",fontFamily:"'Orbitron',sans-serif"}}>{i+1}</div>
          <div style={{fontSize:10,color:"rgba(180,190,210,0.4)",letterSpacing:1,marginTop:3}}>{isC?`${score.wpm} WPM`:"READY"}</div>
          {isC&&<div style={{marginTop:3}}>{[1,2,3].map(s=><span key={s} style={{fontSize:9,opacity:s<=score.stars?1:0.2}}>⭐</span>)}</div>}
        </div>);})}
    </div>
  </div>);
}

// ─── MAIN APP ───
export default function DocRacer() {
  const [screen, setScreen] = useState("library");
  // library | chunks | countdown | race | results | quiz | quizResults
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
  const [isReviewRace, setIsReviewRace] = useState(false);

  // Quiz state
  const [quizQuestions, setQuizQuestions] = useState([]);
  const [quizResults, setQuizResults] = useState([]);

  // Settings
  const [showTime, setShowTime] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [zenMode, setZenMode] = useState(false); // hides red error highlights

  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const pausedTimeRef = useRef(0);

  // Load settings from storage
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("docracer-settings");
        if (r) { const s = JSON.parse(r.value); if (s.showTime !== undefined) setShowTime(s.showTime); if (s.darkMode !== undefined) setDarkMode(s.darkMode); if (s.zenMode !== undefined) setZenMode(s.zenMode); }
      } catch {}
    })();
  }, []);
  const saveSettings = async (st, dm, zm) => { try { await window.storage.set("docracer-settings", JSON.stringify({ showTime: st, darkMode: dm, zenMode: zm })); } catch {} };
  const toggleShowTime = () => { const v = !showTime; setShowTime(v); saveSettings(v, darkMode, zenMode); };
  const toggleDarkMode = () => { const v = !darkMode; setDarkMode(v); saveSettings(showTime, v, zenMode); };
  const toggleZenMode = () => { const v = !zenMode; setZenMode(v); saveSettings(showTime, darkMode, v); };

  // Theme
  const T = darkMode ? {
    bg: "linear-gradient(160deg,#08080f 0%,#0a0e1a 40%,#0d0a18 100%)",
    text: "#e0e8f0", textMuted: "rgba(180,190,210,0.35)", textDim: "rgba(180,190,210,0.25)",
    accent: "#0ff", accent2: "#f0f", accentGlow: "rgba(0,255,255,0.4)",
    cardBg: "rgba(0,255,255,0.03)", cardBorder: "rgba(0,255,255,0.1)", cardHoverBorder: "rgba(0,255,255,0.35)", cardHoverBg: "rgba(0,255,255,0.06)",
    inputBg: "rgba(0,0,0,0.5)", inputBorder: "rgba(0,255,255,0.12)",
    overlayBg: "rgba(8,8,15,0.88)",
    success: "#0f6", error: "#f36", warn: "#ff0",
    trackBg: "linear-gradient(90deg,rgba(0,255,255,0.04),rgba(255,0,255,0.06))", trackBorder: "rgba(0,255,255,0.15)",
    scrollThumb: "rgba(0,255,255,0.15)",
    btnBg: "#333", btnBg2: "#222",
  } : {
    bg: "linear-gradient(160deg,#f5f7fa 0%,#e8ecf1 40%,#f0f2f5 100%)",
    text: "#1a2030", textMuted: "rgba(30,40,60,0.4)", textDim: "rgba(30,40,60,0.3)",
    accent: "#0099aa", accent2: "#aa0088", accentGlow: "rgba(0,153,170,0.3)",
    cardBg: "rgba(0,120,140,0.04)", cardBorder: "rgba(0,120,140,0.15)", cardHoverBorder: "rgba(0,120,140,0.4)", cardHoverBg: "rgba(0,120,140,0.08)",
    inputBg: "rgba(255,255,255,0.7)", inputBorder: "rgba(0,120,140,0.2)",
    overlayBg: "rgba(245,247,250,0.92)",
    success: "#0a8", error: "#d44", warn: "#b80",
    trackBg: "linear-gradient(90deg,rgba(0,120,140,0.06),rgba(170,0,136,0.06))", trackBorder: "rgba(0,120,140,0.2)",
    scrollThumb: "rgba(0,120,140,0.15)",
    btnBg: "#ddd", btnBg2: "#eee",
  };

  useEffect(() => { loadLibrary().then(lib => { setLibrary(lib); setLoading(false); }); }, []);

  useEffect(() => {
    if (screen === "race" && startTime && !raceFinished && !paused) {
      timerRef.current = setInterval(() => {
        const secs = (Date.now() - startTime - pausedTimeRef.current) / 1000;
        setElapsed(secs);
        if (secs > 0) { const tc = charIndex - totalSkipped; setWpm(Math.round((tc / 5) / (secs / 60)) || 0); }
      }, 200);
      return () => clearInterval(timerRef.current);
    }
  }, [screen, startTime, raceFinished, charIndex, totalSkipped, paused]);

  useEffect(() => { if (charIndex > 0) { const t = charIndex - totalSkipped; setAccuracy(t > 0 ? Math.round(((t - totalErrors) / t) * 100) : 100); } }, [charIndex, totalErrors, totalSkipped]);
  useEffect(() => { setNitroActive(streak >= NITRO_STREAK); }, [streak]);

  useEffect(() => {
    if (screen === "countdown") {
      setCountdown(3);
      const iv = setInterval(() => { setCountdown(c => { if (c <= 1) { clearInterval(iv); setScreen("race"); setStartTime(Date.now()); setTimeout(() => inputRef.current?.focus(), 50); return 0; } return c - 1; }); }, 800);
      return () => clearInterval(iv);
    }
  }, [screen]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true); setUploadError("");
    try {
      const text = await extractText(file);
      if (!text || text.trim().length < 10) throw new Error("Not enough text.");
      const totalPages = Math.max(1, Math.ceil(text.length / CHARS_PER_PAGE));
      if (totalPages > 50) throw new Error("Exceeds 50 pages.");
      const chunks = chunkText(text, CHUNK_SIZE * CHARS_PER_PAGE);
      const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const meta = { id: docId, name: file.name, pages: totalPages, totalChunks: chunks.length, chunkScores: new Array(chunks.length).fill(null), bestWpm: 0, uploadedAt: Date.now() };
      await saveDocChunks(docId, chunks);
      const newLib = [meta, ...library]; setLibrary(newLib); await saveLibrary(newLib);
    } catch (err) { setUploadError(err.message || "Upload failed"); }
    setUploading(false); e.target.value = "";
  };

  const handleDelete = async (docId) => { const nl = library.filter(d => d.id !== docId); setLibrary(nl); await saveLibrary(nl); try { await window.storage.delete(`docracer-chunks:${docId}`); } catch {} };

  const handleSelectDoc = async (doc) => { const chunks = await loadDocChunks(doc.id); if (!chunks) { setUploadError("Could not load chunks"); return; } setChunkTexts(chunks); setCurrentDoc(doc); setScreen("chunks"); };

  const startRace = (chunkIdx, reviewText = null) => {
    setCurrentChunkIdx(chunkIdx);
    const cleaned = (reviewText || chunkTexts[chunkIdx] || "").replace(/\s+/g, " ").trim();
    setRaceText(cleaned); setCharIndex(0); setErrors(new Set()); setTotalErrors(0);
    setStartTime(null); setElapsed(0); setWpm(0); setAccuracy(100);
    setStreak(0); setNitroActive(false); setRaceFinished(false);
    setSkippedRanges([]); setTotalSkipped(0);
    setPaused(false); pausedTimeRef.current = 0;
    setIsReviewRace(!!reviewText);
    setScreen("countdown");
  };

  // Start quiz for current section or all sections
  const startQuiz = (sectionIdx = null) => {
    let text;
    if (sectionIdx !== null) {
      text = (chunkTexts[sectionIdx] || "").replace(/\s+/g, " ").trim();
    } else {
      text = chunkTexts.join(" ").replace(/\s+/g, " ").trim();
    }
    const questions = generateQuiz(text, sectionIdx !== null ? QUIZ_QUESTIONS_PER_SECTION : Math.min(QUIZ_QUESTIONS_PER_SECTION * 3, 15));
    setQuizQuestions(questions);
    setQuizResults([]);
    setScreen("quiz");
  };

  const handleQuizFinish = (results) => {
    setQuizResults(results);
    setScreen("quizResults");
  };

  const handleReviewRace = (wrongResults) => {
    // Build review text from the full sentences of wrong answers
    const reviewText = wrongResults.map(r => r.question.fullSentence.trim()).join(" ");
    startRace(currentChunkIdx, reviewText);
  };

  const pauseStartRef = useRef(null);
  const togglePause = useCallback(() => {
    if (raceFinished) return;
    setPaused(prev => {
      if (!prev) { pauseStartRef.current = Date.now(); clearInterval(timerRef.current); }
      else { if (pauseStartRef.current) { pausedTimeRef.current += Date.now() - pauseStartRef.current; pauseStartRef.current = null; } setTimeout(() => inputRef.current?.focus(), 50); }
      return !prev;
    });
  }, [raceFinished]);

  const handleSkipTo = (targetIdx) => {
    if (targetIdx <= charIndex || raceFinished) return;
    setSkippedRanges(prev => [...prev, { start: charIndex, end: targetIdx }]);
    setTotalSkipped(prev => prev + (targetIdx - charIndex));
    setCharIndex(targetIdx); setStreak(0);
    if (!startTime) setStartTime(Date.now());
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleKeyDown = useCallback((e) => {
    if (screen !== "race" || raceFinished) return;
    if (e.key === "Escape") { e.preventDefault(); togglePause(); return; }
    if (paused) return;
    if (e.key.length > 1 && e.key !== "Backspace") return;
    e.preventDefault();
    if (e.key === "Backspace") {
      if (charIndex > 0) { let ni = charIndex - 1; for (const r of skippedRanges) { if (ni >= r.start && ni < r.end) { ni = r.start - 1; break; } }
        if (ni >= 0) { setCharIndex(ni); setErrors(prev => { const n = new Set(prev); n.delete(ni); return n; }); } } return; }
    const expected = raceText[charIndex];
    if (e.key === expected) setStreak(s => s + 1);
    else { setErrors(prev => new Set(prev).add(charIndex)); setTotalErrors(t => t + 1); setStreak(0); }
    const ni = charIndex + 1; setCharIndex(ni);
    if (ni >= raceText.length) finishRace();
  }, [screen, raceFinished, charIndex, raceText, skippedRanges, paused, togglePause]);

  useEffect(() => { window.addEventListener("keydown", handleKeyDown); return () => window.removeEventListener("keydown", handleKeyDown); }, [handleKeyDown]);

  const finishRace = async () => {
    setRaceFinished(true); clearInterval(timerRef.current);
    const fe = (Date.now() - startTime - pausedTimeRef.current) / 1000;
    const tc = raceText.length - totalSkipped;
    const fw = Math.round((tc / 5) / (fe / 60)) || 0;
    const fa = tc > 0 ? Math.round(((tc - totalErrors) / tc) * 100) : 100;
    const stars = fa >= 98 && fw >= 60 ? 3 : fa >= 90 && fw >= 30 ? 2 : 1;
    setWpm(fw); setAccuracy(fa); setElapsed(fe);
    if (currentDoc && !isReviewRace) {
      const ud = { ...currentDoc }; if (!ud.chunkScores) ud.chunkScores = [];
      const ex = ud.chunkScores[currentChunkIdx];
      if (!ex || fw > ex.wpm) ud.chunkScores[currentChunkIdx] = { wpm: fw, accuracy: fa, stars, time: fe };
      ud.bestWpm = Math.max(ud.bestWpm || 0, fw); setCurrentDoc(ud);
      const nl = library.map(d => d.id === ud.id ? ud : d); setLibrary(nl); await saveLibrary(nl);
    }
    setScreen("results");
  };

  const progress = raceText.length > 0 ? charIndex / raceText.length : 0;

  if (loading) return (<div style={{ minHeight:"100vh",background:darkMode?"linear-gradient(160deg,#08080f 0%,#0a0e1a 40%,#0d0a18 100%)":"linear-gradient(160deg,#f5f7fa 0%,#e8ecf1 40%,#f0f2f5 100%)", display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ color: "#0ff", fontFamily: "'Orbitron',sans-serif", fontSize: 18, animation: "pulse 1.5s infinite" }}>LOADING…</div></div>);

  const currentRootStyle = {
    minHeight: "100vh", background: T.bg, color: T.text,
    fontFamily: "'JetBrains Mono',monospace", padding: "0 20px 40px",
    maxWidth: 800, margin: "0 auto", position: "relative", overflow: "hidden",
    transition: "background 0.4s, color 0.4s",
  };

  return (
    <div style={currentRootStyle} onClick={() => { if (screen === "race") inputRef.current?.focus(); }}>
      <input ref={inputRef} style={{ position: "absolute", opacity: 0, pointerEvents: "none" }} autoFocus={screen === "race"} />

      <div style={{ textAlign: "center", padding: "18px 0 8px" }}>
        <div style={{ fontSize: 32, fontWeight: 900, fontFamily: "'Orbitron',sans-serif", background: `linear-gradient(90deg,${T.accent},${T.accent2},${T.accent})`, backgroundSize: "200% 100%", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", animation: "shimmer 3s linear infinite", letterSpacing: 4 }}>DOCRACER</div>
        <div style={{ fontSize: 11, letterSpacing: 4, color: T.textDim, marginTop: 2 }}>TYPE • LEARN • QUIZ • MASTER</div>
        {/* Settings bar */}
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 10 }}>
          <button onClick={toggleShowTime} style={{
            padding: "4px 12px", fontSize: 11, fontWeight: 600, letterSpacing: 1,
            background: showTime ? `${T.accent}18` : "transparent",
            color: showTime ? T.accent : T.textMuted,
            border: `1px solid ${showTime ? `${T.accent}44` : `${T.textMuted}33`}`,
            borderRadius: 20, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", transition: "all 0.2s",
          }}>
            {showTime ? "⏱ TIME ON" : "⏱ TIME OFF"}
          </button>
          <button onClick={toggleDarkMode} style={{
            padding: "4px 12px", fontSize: 11, fontWeight: 600, letterSpacing: 1,
            background: "transparent",
            color: T.textMuted,
            border: `1px solid ${T.textMuted}33`,
            borderRadius: 20, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", transition: "all 0.2s",
          }}>
            {darkMode ? "🌙 DARK" : "☀️ LIGHT"}
          </button>
          <button onClick={toggleZenMode} style={{
            padding: "4px 12px", fontSize: 11, fontWeight: 600, letterSpacing: 1,
            background: zenMode ? `${T.success}18` : "transparent",
            color: zenMode ? T.success : T.textMuted,
            border: `1px solid ${zenMode ? `${T.success}44` : `${T.textMuted}33`}`,
            borderRadius: 20, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", transition: "all 0.2s",
          }}>
            {zenMode ? "🧘 ZEN ON" : "🧘 ZEN OFF"}
          </button>
        </div>
      </div>

      {screen === "library" && <Library library={library} onSelect={handleSelectDoc} onUpload={handleUpload} uploading={uploading} uploadError={uploadError} onDelete={handleDelete} />}

      {screen === "chunks" && currentDoc && <ChunkSelector doc={currentDoc} onSelect={i => startRace(i)} onBack={() => setScreen("library")} onQuizAll={() => startQuiz(null)} />}

      {screen === "countdown" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300 }}>
          {isReviewRace && <div style={{ fontSize: 12, letterSpacing: 3, color: "rgba(255,0,255,0.5)", marginBottom: 16 }}>REVIEW RACE — MISSED QUESTIONS</div>}
          <div style={{ fontSize: 120, fontWeight: 900, fontFamily: "'Orbitron',sans-serif", color: isReviewRace ? "#f0f" : "#0ff", textShadow: `0 0 40px ${isReviewRace ? "rgba(255,0,255,0.5)" : "rgba(0,255,255,0.5)"}`, animation: "countPulse 0.8s ease-in-out infinite" }}>{countdown}</div>
        </div>
      )}

      {screen === "race" && (
        <div style={{ position: "relative" }}>
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 4px 4px" }}>
            {isReviewRace && <span style={{ fontSize: 11, color: "rgba(255,0,255,0.4)", letterSpacing: 2, marginRight: "auto", paddingTop: 6 }}>REVIEW RACE</span>}
            <button onClick={togglePause} style={{ ...btnStyle("rgba(255,255,255,0.05)", "rgba(180,190,210,0.5)"), padding: "6px 16px", fontSize: 12, borderRadius: 6 }}>
              {paused ? "▶ RESUME" : "⏸ PAUSE"} <span style={{ opacity: 0.4, marginLeft: 6, fontSize: 10 }}>ESC</span>
            </button>
          </div>
          <Racetrack progress={progress} nitroActive={nitroActive} />
          <StatsBar wpm={wpm} accuracy={accuracy} elapsed={elapsed} progress={progress} skippedCount={totalSkipped} showTime={showTime} T={T} zenMode={zenMode} />
          <TypingDisplay text={raceText} currentIndex={charIndex} errors={errors} skippedRanges={skippedRanges} onSkipToLine={handleSkipTo} darkMode={darkMode} zenMode={zenMode} />
          {nitroActive && !paused && <div style={{ textAlign: "center", marginTop: 8, fontSize: 12, color: "#f0f", letterSpacing: 4, fontWeight: 700, textShadow: "0 0 10px #f0f", animation: "pulse 0.5s infinite" }}>⚡ NITRO ACTIVE ⚡</div>}
          <div style={{ textAlign: "center", marginTop: 10, fontSize: 12, color: "rgba(180,190,210,0.25)" }}>
            {isReviewRace ? "Review Race" : `Section ${currentChunkIdx + 1} of ${currentDoc?.totalChunks || 1}`} • Click anywhere to focus
          </div>
          {paused && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(8,8,15,0.88)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", borderRadius: 12, zIndex: 20, backdropFilter: "blur(6px)" }}>
              <div style={{ fontSize: 48, fontWeight: 900, fontFamily: "'Orbitron',sans-serif", color: "#0ff", textShadow: "0 0 30px rgba(0,255,255,0.4)", marginBottom: 12, animation: "pulse 2s infinite" }}>PAUSED</div>
              <div style={{ fontSize: 13, color: "rgba(180,190,210,0.4)", marginBottom: 28, letterSpacing: 2 }}>Press <span style={{ color: "#0ff", fontWeight: 700 }}>ESC</span> or click to resume</div>
              <div style={{ display: "flex", gap: 12 }}>
                <button onClick={togglePause} style={btnStyle("rgba(0,255,255,0.15)", "#0ff")}>▶ RESUME</button>
                <button onClick={() => { setPaused(false); setScreen("chunks"); }} style={btnStyle("#222", "rgba(255,51,102,0.6)")}>✕ QUIT</button>
              </div>
            </div>
          )}
        </div>
      )}

      {screen === "results" && (
        <ResultsScreen wpm={wpm} accuracy={accuracy} time={elapsed} errors={totalErrors} skipped={totalSkipped}
          hasNext={!isReviewRace && currentDoc && currentChunkIdx < currentDoc.totalChunks - 1}
          onNext={() => startRace(currentChunkIdx + 1)}
          onReplay={() => isReviewRace ? startRace(currentChunkIdx, raceText) : startRace(currentChunkIdx)}
          onLibrary={() => setScreen("chunks")}
          onQuiz={!isReviewRace ? () => startQuiz(currentChunkIdx) : null}
          isReviewRace={isReviewRace} />
      )}

      {screen === "quiz" && <QuizScreen questions={quizQuestions} onFinish={handleQuizFinish} />}

      {screen === "quizResults" && <QuizResultsScreen results={quizResults} onReviewRace={handleReviewRace} onBack={() => setScreen("chunks")} />}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:wght@400;600;700&display=swap');
        @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
        @keyframes countPulse{0%{transform:scale(1)}50%{transform:scale(1.15)}100%{transform:scale(1)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${T.scrollThumb};border-radius:3px}
      `}</style>
    </div>
  );
}
