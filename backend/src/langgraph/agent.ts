import { StateGraph, START, END, Annotation, MemorySaver } from '@langchain/langgraph';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { searchSimilarChunks } from '../qdrant/client';
import { generateEmbeddings } from '../services/embedding.service';
import { apiKeyManager } from '../services/key.service';

// ──────────────────────────────────────────────
// Retry helper — honours retry-after from 429 errors
// Properly passes cooldown duration to key rotation
// ──────────────────────────────────────────────
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 2000,
  label = 'llm call'
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const errMsg = err?.message || String(err);
      const is429 = errMsg.includes('429') || err?.status === 429;
      const isNetwork = err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT';

      if (attempt < maxRetries && (is429 || isNetwork)) {
        // Parse "retry in Xs" from error message
        const retryMatch = errMsg.match(/retry\s+in\s+([\d.]+)s/i);
        const retryAfterMs = retryMatch
          ? Math.ceil(parseFloat(retryMatch[1])) * 1000
          : baseDelayMs * Math.pow(2, attempt); // 2s → 4s → 8s

        if (is429 && apiKeyManager.getKeyCount() > 1) {
          // Rotate with cooldown so the used key isn't immediately reused
          console.warn(`[LangGraph retry] ${label} attempt ${attempt + 1}/${maxRetries} hit 429. Rotating API key...`);
          apiKeyManager.rotate(retryAfterMs);
          continue; // retry immediately with the new key — no sleep needed
        }

        const waitSec = Math.round(retryAfterMs / 1000);
        console.warn(`[LangGraph retry] ${label} attempt ${attempt + 1}/${maxRetries} failed (${is429 ? '429' : err?.code}). Waiting ${waitSec}s...`);
        await sleep(retryAfterMs);
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

// ──────────────────────────────────────────────
// Graph State
// ──────────────────────────────────────────────
export const GraphState = Annotation.Root({
  messages: Annotation<any[]>({
    reducer: (x, y) => y,
    default: () => [],
  }),
  videoAMetadata: Annotation<any>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  videoBMetadata: Annotation<any>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  retrievedContext: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
});

// Always create LLM with the currently active key so rotation takes effect
function getLlm() {
  return new ChatGoogleGenerativeAI({
    apiKey: apiKeyManager.getActiveKey(),
    model: 'gemini-2.5-flash',
    maxOutputTokens: 2048,
    temperature: 0.2,
  });
}

// ──────────────────────────────────────────────
// Graph Nodes
// ──────────────────────────────────────────────

// routeQuery: decides if we need vector search or just metadata.
// Uses an expanded heuristic keyword router for instant decisions and zero LLM latency.
async function routeQuery(state: typeof GraphState.State) {
  const lastMessage = (state.messages[state.messages.length - 1].content || '').toLowerCase();

  const metadataKeywords = [
    'views', 'likes', 'followers', 'engagement', 'engagement rate',
    'creator', 'platform', 'compare metrics', 'performance', 'stats',
    'statistics', 'which', 'how many', 'who got more',
    'follower count', 'upload date', 'duration', 'hashtag',
  ];
  
  const transcriptKeywords = [
    'hook', 'script', 'say', 'mention', 'word', 'transcript',
    'content', 'narrat', 'spoken', 'first second', 'opening',
    'cta', 'call to action', 'pacing', 'structure', 'improve',
    'suggest', 'better', 'why', 'how did', 'what did', 'compare hook',
    'retention', 'format',
  ];

  const hasMetadataKeyword = metadataKeywords.some(kw => lastMessage.includes(kw));
  const hasTranscriptKeyword = transcriptKeywords.some(kw => lastMessage.includes(kw));

  if (hasTranscriptKeyword) {
    console.log('[routeQuery] Heuristic matched transcript keyword → retrieve');
    return 'retrieve';
  }

  if (hasMetadataKeyword) {
    console.log('[routeQuery] Heuristic matched metadata keyword → compile_metadata');
    return 'compile_metadata';
  }

  // Default fallback if neither keyword lists match (safest to retrieve)
  console.log('[routeQuery] No keyword match, defaulting to retrieve');
  return 'retrieve';
}

// retrieve: fetches relevant transcript chunks from Qdrant with error handling
async function retrieve(state: typeof GraphState.State) {
  try {
    const lastMessage = state.messages[state.messages.length - 1].content;
    const embedding = await generateEmbeddings(lastMessage);

    let results: any[] = [];
    if (state.videoAMetadata && state.videoBMetadata) {
      const [resultsA, resultsB] = await Promise.all([
        searchSimilarChunks(embedding, 'videoId', 'A').catch(() => [] as any[]),
        searchSimilarChunks(embedding, 'videoId', 'B').catch(() => [] as any[]),
      ]);
      results = [...resultsA, ...resultsB];
    } else {
      results = await searchSimilarChunks(embedding).catch(() => [] as any[]);
    }

    const context = results
      .filter(r => r.payload?.text)
      .map(r =>
        `[Video ${r.payload?.videoId || 'Unknown'} - ${r.payload?.platform} - Chunk ${r.payload?.chunkIndex}]: ${r.payload?.text}`
      );

    console.log(`[retrieve] Found ${context.length} relevant chunks`);
    return { retrievedContext: context };
  } catch (err: any) {
    console.error('[retrieve] Qdrant search failed:', err?.message?.slice(0, 100));
    return { retrievedContext: [] };
  }
}

// compileMetadata: assembles metadata context without any vector search
async function compileMetadata(state: typeof GraphState.State) {
  const context: string[] = [];
  if (state.videoAMetadata) {
    context.push(`Video A Metadata: ${JSON.stringify(state.videoAMetadata)}`);
  }
  if (state.videoBMetadata) {
    context.push(`Video B Metadata: ${JSON.stringify(state.videoBMetadata)}`);
  }
  return { retrievedContext: context };
}

// synthesize: injects rich system prompt with all context into messages.
// The actual LLM call happens in the chat controller's streaming phase.
async function synthesize(state: typeof GraphState.State) {
  const metadataContext: string[] = [];
  if (state.videoAMetadata) {
    metadataContext.push(
      `Video A (${state.videoAMetadata.platform || 'Unknown'}) Metadata:\n${JSON.stringify(state.videoAMetadata, null, 2)}`
    );
  }
  if (state.videoBMetadata) {
    metadataContext.push(
      `Video B (${state.videoBMetadata.platform || 'Unknown'}) Metadata:\n${JSON.stringify(state.videoBMetadata, null, 2)}`
    );
  }

  const metadataText = metadataContext.join('\n\n');
  const transcriptText = state.retrievedContext.join('\n\n');

  const systemPrompt = `You are an expert social media content creator analyst. Answer the user's question thoroughly using the provided metadata and transcript context.

RESPONSE GUIDELINES:
1. DIRECT ANSWER: Answer the user's specific question clearly and first.
2. MISSING METRICS: If asked about retention/watch-time (not in metadata), pivot to a Structural Pacing & Retention Audit using transcripts.
3. COMPARISON TABLE: For comparative queries, include: Metric | Video A | Video B.
4. CITE SOURCES: Cite transcript sources as [Video A - Chunk N] or [Video B - Chunk N].
5. FORMATTING: Use bullet points, bold (**text**) for key insights, and markdown headers.
6. DATA NOTES: If dataSource="estimated", clearly note those metrics are estimates.
7. CONFIDENCE: If data is missing or estimated, say so instead of inventing numbers.

VIDEO METADATA:
${metadataText || 'No video metadata available.'}

TRANSCRIPT CONTEXT:
${transcriptText || 'No transcript context found — answer using metadata only.'}`;

  return { messages: [{ role: 'system', content: systemPrompt }, ...state.messages] };
}

// ──────────────────────────────────────────────
// Build graph
// ──────────────────────────────────────────────
const builder = new StateGraph(GraphState)
  .addNode('retrieve', retrieve)
  .addNode('compile_metadata', compileMetadata)
  .addNode('synthesize', synthesize)
  .addConditionalEdges(START, routeQuery, {
    'retrieve': 'retrieve',
    'compile_metadata': 'compile_metadata'
  })
  .addEdge('retrieve', 'synthesize')
  .addEdge('compile_metadata', 'synthesize')
  .addEdge('synthesize', END);

const checkpointer = new MemorySaver();
export const agentGraph = builder.compile({ checkpointer });

// getLlmStream: used by chat controller to stream the final response
export const getLlmStream = async (messages: any[]) => {
  return await getLlm().stream(messages);
};
