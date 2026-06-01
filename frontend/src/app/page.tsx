'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, Loader2, PlaySquare, Sparkles, Activity, Heart, AlertCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const BACKEND = 'http://localhost:3001';

const InstagramIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
    <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
  </svg>
);

// ──────────────────────────────────────────────
// Skeleton components
// ──────────────────────────────────────────────
function SkeletonBar({ w = 'w-full', h = 'h-3' }: { w?: string; h?: string }) {
  return (
    <div className={`${w} ${h} rounded-md bg-white/[0.06] animate-pulse`} />
  );
}

function MetadataSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-3 mt-4">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="p-3 rounded-xl border border-white/5 bg-black/30 space-y-2">
          <SkeletonBar w="w-2/3" h="h-2" />
          <SkeletonBar w="w-full" h="h-5" />
        </div>
      ))}
    </div>
  );
}

function ChatSkeletonMessage() {
  return (
    <div className="flex justify-start animate-in fade-in duration-300">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-6 py-4 bg-white/5 border border-white/10 space-y-2 w-80">
        <SkeletonBar w="w-full" h="h-3" />
        <SkeletonBar w="w-5/6" h="h-3" />
        <SkeletonBar w="w-4/6" h="h-3" />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// StatBox
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// Number formatter: 1234567 → "1.23M"
// ──────────────────────────────────────────────
function fmtNum(n: number): string {
  if (!n || n === 0) return 'N/A';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function StatBox({ label, value, highlight = false, icon, dim = false }: {
  label: string; value: string; highlight?: boolean; icon: React.ReactNode; dim?: boolean;
}) {
  return (
    <div className={`p-3 rounded-xl border flex flex-col gap-1 transition-colors duration-300 ${
      highlight ? 'bg-indigo-500/10 border-indigo-500/20' : 'bg-black/30 border-white/5'
    }`}>
      <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-500 flex items-center gap-1.5">
        {icon} {label}
      </span>
      <span className={`font-semibold tracking-tight truncate ${
        dim ? 'text-neutral-500 text-sm italic' :
        highlight ? 'text-indigo-300 text-base' : 'text-white text-sm'
      }`}>{value}</span>
    </div>
  );
}

// ──────────────────────────────────────────────
// Toast
// ──────────────────────────────────────────────
function Toast({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3.5
      bg-red-500/20 border border-red-500/40 rounded-2xl text-red-300 text-sm shadow-2xl
      animate-in slide-in-from-bottom-3 fade-in duration-300 backdrop-blur-xl">
      <AlertCircle className="w-4 h-4 shrink-0" />
      {msg}
      <button onClick={onDismiss} className="ml-2 opacity-60 hover:opacity-100 text-xs">✕</button>
    </div>
  );
}

// ──────────────────────────────────────────────
// Main Page
// ──────────────────────────────────────────────
export default function Home() {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [instagramUrl, setInstagramUrl] = useState('');
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestingA, setIngestingA] = useState(false);
  const [ingestingB, setIngestingB] = useState(false);
  const [chatMessage, setChatMessage] = useState('');
  const [chatHistory, setChatHistory] = useState<any[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [videoAMetadata, setVideoAMetadata] = useState<any>(null);
  const [videoBMetadata, setVideoBMetadata] = useState<any>(null);
  const [loadingStep, setLoadingStep] = useState<string>('Connecting...');
  const [toastMsg, setToastMsg] = useState('');
  const [rateLimitTimer, setRateLimitTimer] = useState(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory]);

  // Rate limit countdown effect
  useEffect(() => {
    if (rateLimitTimer > 0) {
      const timer = setTimeout(() => setRateLimitTimer(t => t - 1), 1000);
      return () => clearTimeout(timer);
    } else if (rateLimitTimer === 0 && chatHistory.length > 0) {
      const lastMsg = chatHistory[chatHistory.length - 1];
      if (lastMsg.role === 'assistant' && lastMsg.isRateLimitState) {
        // Auto-retry when timer hits 0
        setChatHistory(prev => {
          const next = [...prev];
          next.pop(); // remove rate limit message
          return next;
        });
        const lastUserMsg = chatHistory[chatHistory.length - 2]?.content;
        if (lastUserMsg) {
          setChatMessage(lastUserMsg);
          // Small delay before firing to allow state to settle
          setTimeout(() => {
            const form = document.getElementById('chat-form');
            if (form) form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
          }, 100);
        }
      }
    }
  }, [rateLimitTimer, chatHistory]);

  const showError = (msg: string) => setToastMsg(msg);

  const handleIngest = async () => {
    if (isIngesting) return;
    setIsIngesting(true);
    if (youtubeUrl) setIngestingA(true);
    if (instagramUrl) setIngestingB(true);
    setVideoAMetadata(null);
    setVideoBMetadata(null);

    try {
      const controller = new AbortController();
      // 5-minute timeout — ingestion (download + transcribe + embed) can take ~2 min
      const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);

      const res = await fetch(`${BACKEND}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: youtubeUrl || undefined, instagramUrl: instagramUrl || undefined }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const data = await res.json();
      if (!res.ok || !data.success) {
        showError(data.message || 'Ingestion failed. Check backend logs.');
      } else {
        if (data.metadataA) setVideoAMetadata(data.metadataA);
        if (data.metadataB) setVideoBMetadata(data.metadataB);
        if (data.message && data.message.includes('warning')) {
          showError(data.message);
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        showError('Ingestion timed out after 5 minutes.');
      } else {
        showError('Cannot reach backend. Is the server running on port 3001?');
      }
    } finally {
      setIsIngesting(false);
      setIngestingA(false);
      setIngestingB(false);
    }
  };

  const handleChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatMessage.trim() || isChatLoading) return;

    // Cancel any in-flight stream
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const newMessage = chatMessage.trim();
    const updatedHistory = [...chatHistory, { role: 'user', content: newMessage }];
    setChatHistory(updatedHistory);
    setChatMessage('');
    setIsChatLoading(true);
    setLoadingStep('Connecting...');

    // Optimistically add empty assistant bubble
    setChatHistory(h => [...h, { role: 'assistant', content: '' }]);

    try {
      const response = await fetch(`${BACKEND}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updatedHistory, videoAMetadata, videoBMetadata }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let currentAiMessage = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete last line

        let isDone = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const raw = trimmed.slice(6).trim();
          if (raw === '[DONE]') {
            isDone = true;
            break;
          }

          try {
            const parsed = JSON.parse(raw);
            if (parsed.error === 'rate_limited') {
              const waitSec = parsed.retryAfter || 60;
              setRateLimitTimer(waitSec);
              setChatHistory(prev => {
                const next = [...prev];
                next[next.length - 1] = { 
                  role: 'assistant', 
                  content: `⚠️ **AI Rate Limit Hit**\nThe system is experiencing high demand. Retrying automatically in ${waitSec} seconds...`,
                  isRateLimitState: true 
                };
                return next;
              });
              isDone = true;
              break; // Stop processing this stream
            } else if (parsed.error) {
              showError(parsed.error);
            } else if (parsed.step) {
              setLoadingStep(parsed.step);
            } else if (parsed.text) {
              currentAiMessage += parsed.text;
              setChatHistory(prev => {
                const next = [...prev];
                next[next.length - 1] = { role: 'assistant', content: currentAiMessage };
                return next;
              });
            }
          } catch {
            // non-JSON line — ignore
          }
        }
        
        if (isDone) break;
      }

      // If we never got any text, show fallback
      if (!currentAiMessage) {
        setChatHistory(prev => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: 'No response received. Please try again.' };
          return next;
        });
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setChatHistory(prev => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: '⚠️ Connection error. Please try again.' };
          return next;
        });
      }
    } finally {
      setIsChatLoading(false);
    }
  };

  const ingestReady = !isIngesting && (!!videoAMetadata || !!videoBMetadata);

  return (
    <main className="flex h-screen bg-[#0a0a0a] text-white font-sans overflow-hidden selection:bg-indigo-500/30">

      {toastMsg && <Toast msg={toastMsg} onDismiss={() => setToastMsg('')} />}

      {/* Background ambient glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-indigo-500/20 blur-[120px] rounded-full pointer-events-none opacity-50" />

      {/* ── LEFT PANEL ── */}
      <section className="w-1/2 flex flex-col border-r border-white/[0.08] p-8 overflow-y-auto relative z-10 backdrop-blur-3xl bg-black/40">

        <header className="mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-indigo-300 mb-4 tracking-wide uppercase">
            <Sparkles className="w-3.5 h-3.5" /> Core Analytics Engine
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight bg-gradient-to-br from-white via-white to-white/40 bg-clip-text text-transparent">
            Creator RAG Matrix
          </h1>
          <p className="text-neutral-400 mt-2 text-sm leading-relaxed max-w-md">
            Input source URLs to dynamically vectorize transcripts and calculate unified engagement parity metrics.
          </p>
        </header>

        <div className="space-y-6 flex-1">

          {/* Card A – YouTube */}
          <div className="group relative">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-red-500/50 to-orange-500/50 rounded-2xl blur opacity-0 group-hover:opacity-100 transition duration-500" />
            <div className="relative bg-neutral-900/80 backdrop-blur-xl rounded-2xl p-6 border border-white/10 hover:border-white/20 transition-all duration-300">
              <h2 className="text-lg font-bold mb-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-red-500/10 text-red-500"><PlaySquare className="w-5 h-5" /></div>
                YouTube Source
                {ingestingA && (
                  <span className="ml-auto flex items-center gap-1.5 text-xs text-red-400 font-medium">
                    <Loader2 className="w-3 h-3 animate-spin" /> Processing…
                  </span>
                )}
              </h2>
              <input type="text" placeholder="https://youtube.com/shorts/..."
                className="w-full bg-black/50 border border-white/10 rounded-xl px-5 py-3.5 mb-2 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/50 text-white placeholder:text-neutral-600 transition-all duration-300"
                value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)} />

              {ingestingA && <MetadataSkeleton />}
              {!ingestingA && videoAMetadata && (
                <>
                  <div className="grid grid-cols-4 gap-3 mt-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <StatBox label="Creator" value={videoAMetadata.creator} icon={<PlaySquare className="w-4 h-4 text-neutral-400" />} />
                    <StatBox label="Followers" value={fmtNum(videoAMetadata.followerCount)} dim={!videoAMetadata.followerCount} icon={<Heart className="w-4 h-4 text-neutral-400" />} />
                    <StatBox label="Views" value={fmtNum(videoAMetadata.views)} dim={!videoAMetadata.views} icon={<PlaySquare className="w-4 h-4 text-neutral-400" />} />
                    <StatBox label="Eng Rate" value={videoAMetadata.engagementRate > 0 ? Number(videoAMetadata.engagementRate).toFixed(2) + '%' : 'N/A'} dim={!videoAMetadata.engagementRate} highlight icon={<Activity className="w-4 h-4 text-red-400" />} />
                  </div>
                  {videoAMetadata.dataSource === 'estimated' && (
                    <p className="text-xs text-yellow-500/70 mt-3 flex items-center gap-1.5"><AlertCircle className="w-3 h-3"/> Some metrics are estimated due to platform restrictions.</p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Card B – Instagram */}
          <div className="group relative">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-pink-500/50 to-purple-500/50 rounded-2xl blur opacity-0 group-hover:opacity-100 transition duration-500" />
            <div className="relative bg-neutral-900/80 backdrop-blur-xl rounded-2xl p-6 border border-white/10 hover:border-white/20 transition-all duration-300">
              <h2 className="text-lg font-bold mb-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-pink-500/10 text-pink-500"><InstagramIcon className="w-5 h-5" /></div>
                Instagram Source
                {ingestingB && (
                  <span className="ml-auto flex items-center gap-1.5 text-xs text-pink-400 font-medium">
                    <Loader2 className="w-3 h-3 animate-spin" /> Processing…
                  </span>
                )}
              </h2>
              <input type="text" placeholder="https://instagram.com/reel/..."
                className="w-full bg-black/50 border border-white/10 rounded-xl px-5 py-3.5 mb-2 focus:outline-none focus:border-pink-500/50 focus:ring-1 focus:ring-pink-500/50 text-white placeholder:text-neutral-600 transition-all duration-300"
                value={instagramUrl} onChange={e => setInstagramUrl(e.target.value)} />

              {ingestingB && <MetadataSkeleton />}
              {!ingestingB && videoBMetadata && (
                <>
                  <div className="grid grid-cols-4 gap-3 mt-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <StatBox label="Creator" value={videoBMetadata.creator} icon={<PlaySquare className="w-4 h-4 text-neutral-400" />} />
                    <StatBox label="Followers" value={fmtNum(videoBMetadata.followerCount)} dim={!videoBMetadata.followerCount} icon={<Heart className="w-4 h-4 text-pink-400" />} />
                    <StatBox label="Views" value={fmtNum(videoBMetadata.views)} dim={!videoBMetadata.views} icon={<PlaySquare className="w-4 h-4 text-neutral-400" />} />
                    <StatBox label="Eng Rate" value={videoBMetadata.engagementRate > 0 ? Number(videoBMetadata.engagementRate).toFixed(2) + '%' : 'N/A'} dim={!videoBMetadata.engagementRate} highlight icon={<Activity className="w-4 h-4 text-pink-400" />} />
                  </div>
                  {videoBMetadata.dataSource === 'estimated' && (
                    <p className="text-xs text-yellow-500/70 mt-3 flex items-center gap-1.5"><AlertCircle className="w-3 h-3"/> Some metrics are estimated due to platform restrictions.</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Ingest button */}
        <button onClick={handleIngest}
          disabled={(!youtubeUrl && !instagramUrl) || isIngesting}
          className="relative w-full overflow-hidden rounded-xl p-[1px] group disabled:opacity-50 disabled:cursor-not-allowed mt-8 transition-transform duration-300 active:scale-[0.98]">
          <span className="absolute inset-0 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 opacity-70 group-hover:opacity-100 transition-opacity duration-300" />
          <div className="relative bg-black/80 backdrop-blur-xl px-8 py-4 rounded-xl flex items-center justify-center gap-2">
            {isIngesting ? (
              <>
                <Loader2 className="animate-spin w-5 h-5 text-indigo-400" />
                <span className="font-semibold text-indigo-100">Synchronizing Vectors…</span>
              </>
            ) : (
              <span className="font-bold text-white tracking-wide">Initialize Analysis</span>
            )}
          </div>
        </button>

        {ingestReady && (
          <p className="mt-3 text-center text-xs text-emerald-400 animate-in fade-in duration-500">
            ✓ Vectors indexed — ask anything in the chat
          </p>
        )}
      </section>

      {/* ── RIGHT PANEL – Chat ── */}
      <section className="w-1/2 flex flex-col relative bg-transparent z-10">
        <div className="flex-1 overflow-y-auto p-8 space-y-6 scroll-smooth">
          {chatHistory.length === 0 ? (
            <div className="h-full flex items-center justify-center text-neutral-500 animate-in fade-in duration-1000">
              <div className="text-center space-y-4 max-w-sm">
                <div className="w-16 h-16 mx-auto rounded-full bg-white/5 border border-white/10 flex items-center justify-center shadow-[0_0_40px_rgba(255,255,255,0.05)]">
                  <Sparkles className="w-7 h-7 text-indigo-400" />
                </div>
                <h3 className="text-xl font-semibold text-neutral-200">Awaiting Inquiry</h3>
                <p className="text-sm leading-relaxed">
                  &ldquo;Analyze the hook retention in the first 5 seconds.&rdquo;<br />
                  &ldquo;Why did the YouTube variant convert better?&rdquo;
                </p>
              </div>
            </div>
          ) : (
            chatHistory.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-2 fade-in duration-300`}>
                <div className={`max-w-[85%] rounded-2xl px-6 py-4 shadow-2xl backdrop-blur-md border ${
                  msg.role === 'user'
                    ? 'bg-gradient-to-br from-indigo-600/90 to-purple-600/90 text-white rounded-br-sm border-indigo-400/30'
                    : 'bg-white/5 text-neutral-200 rounded-bl-sm border-white/10 leading-relaxed tracking-wide'
                }`}>
                  {msg.role === 'user' ? (
                    msg.content
                  ) : msg.content === '' && isChatLoading ? (
                    // Inline skeleton while streaming starts
                    <div className="space-y-2 w-64">
                      <SkeletonBar w="w-full" h="h-3" />
                      <SkeletonBar w="w-5/6" h="h-3" />
                      <SkeletonBar w="w-4/6" h="h-3" />
                    </div>
                  ) : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                      p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                      strong: ({ children }) => <strong className="font-bold text-indigo-300">{children}</strong>,
                      table: ({ children }) => (
                        <div className="overflow-x-auto my-4 rounded-xl border border-white/10 bg-black/30 backdrop-blur-md">
                          <table className="w-full border-collapse text-left">{children}</table>
                        </div>
                      ),
                      thead: ({ children }) => <thead className="bg-white/5 border-b border-white/10">{children}</thead>,
                      tbody: ({ children }) => <tbody className="divide-y divide-white/5">{children}</tbody>,
                      tr: ({ children }) => <tr className="hover:bg-white/[0.02] transition-colors">{children}</tr>,
                      th: ({ children }) => <th className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-neutral-400">{children}</th>,
                      td: ({ children }) => <td className="px-4 py-3 text-sm text-neutral-300 font-medium">{children}</td>,
                      ul: ({ children }) => <ul className="list-disc pl-5 mb-4 space-y-2 text-neutral-300">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal pl-5 mb-4 space-y-2 text-neutral-300">{children}</ol>,
                      li: ({ children }) => <li className="text-sm leading-relaxed">{children}</li>,
                      h1: ({ children }) => <h1 className="text-2xl font-extrabold text-white mt-6 mb-3 first:mt-0 tracking-tight">{children}</h1>,
                      h2: ({ children }) => <h2 className="text-xl font-bold text-white mt-5 mb-3 first:mt-0 tracking-tight">{children}</h2>,
                      h3: ({ children }) => <h3 className="text-lg font-bold text-indigo-300 mt-4 mb-2 first:mt-0 tracking-tight">{children}</h3>,
                      h4: ({ children }) => <h4 className="text-base font-semibold text-neutral-200 mt-3 mb-2">{children}</h4>,
                      code: ({ children }) => <code className="px-1.5 py-0.5 rounded bg-white/10 text-pink-300 text-xs font-mono">{children}</code>,
                      pre: ({ children }) => <pre className="p-4 rounded-xl bg-black/50 border border-white/10 font-mono text-xs overflow-x-auto my-3 text-indigo-200">{children}</pre>,
                      a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-4 transition-colors">{children}</a>,
                    }}>
                      {msg.content}
                    </ReactMarkdown>
                  )}
                </div>
              </div>
            ))
          )}

          {/* Chat skeleton while waiting for first token */}
          {isChatLoading && chatHistory[chatHistory.length - 1]?.role !== 'assistant' && (
            <ChatSkeletonMessage />
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Chat input */}
        <div className="p-6 bg-gradient-to-t from-black via-black/90 to-transparent">
          {rateLimitTimer > 0 && (
            <div className="mb-4 text-center">
              <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-xs font-medium text-red-300">
                <Loader2 className="w-3 h-3 animate-spin" /> Auto-retrying in {rateLimitTimer}s...
              </span>
            </div>
          )}
          <form id="chat-form" onSubmit={handleChat} className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-2xl blur opacity-20 group-hover:opacity-40 transition duration-500" />
            <input type="text" value={chatMessage}
              onChange={e => setChatMessage(e.target.value)}
              placeholder="Ask anything about the vectors…"
              className="relative w-full bg-neutral-900/90 backdrop-blur-xl border border-white/10 rounded-2xl px-6 py-5 pr-16 focus:outline-none focus:border-indigo-500/50 text-white placeholder:text-neutral-500 shadow-2xl transition-all duration-300 text-lg"
            />
            <button type="submit"
              disabled={isChatLoading || !chatMessage.trim()}
              className="absolute right-3 top-3 bottom-3 bg-white text-black p-3 rounded-xl hover:bg-neutral-200 hover:scale-105 active:scale-95 transition-all duration-300 disabled:opacity-30 disabled:hover:scale-100 flex items-center justify-center shadow-lg">
              {isChatLoading ? <Loader2 className="w-5 h-5 animate-spin text-neutral-500" /> : <Send className="w-5 h-5" />}
            </button>
          </form>
          {isChatLoading && (
            <p className="text-center text-xs text-neutral-500 mt-2 animate-pulse">
              {loadingStep}
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
