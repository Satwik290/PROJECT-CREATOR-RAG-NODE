import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { agentGraph } from '../langgraph/agent';
import { getCached, setCached, cacheKey, TTL } from '../services/cache.service';
import { apiKeyManager } from '../services/key.service';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

// ──────────────────────────────────────────────
// Sleep helper
// ──────────────────────────────────────────────
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// ──────────────────────────────────────────────
// Unified retry wrapper — handles 429 with key rotation
// and exponential backoff for single-key setups
// ──────────────────────────────────────────────
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 2000,
  label = 'call'
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
        // Parse retry-after from Google API error (e.g. "retry in 53.6s")
        const retryMatch = errMsg.match(/retry\s+in\s+([\d.]+)s/i);
        const retryAfterMs = retryMatch
          ? Math.ceil(parseFloat(retryMatch[1])) * 1000
          : baseDelayMs * Math.pow(2, attempt);

        if (is429 && apiKeyManager.getKeyCount() > 1) {
          console.warn(`[chat retry] ${label} attempt ${attempt + 1}/${maxRetries} hit 429. Rotating API key...`);
          apiKeyManager.rotate(retryAfterMs); // put current key on cooldown
          continue; // retry immediately with next key
        }

        const waitSec = Math.round(retryAfterMs / 1000);
        console.warn(`[chat retry] ${label} attempt ${attempt + 1}/${maxRetries} — waiting ${waitSec}s`);
        await sleep(retryAfterMs);
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

// ──────────────────────────────────────────────
// LLM factory — always uses the current active key
// ──────────────────────────────────────────────
const getLlm = () => new ChatGoogleGenerativeAI({
  apiKey: apiKeyManager.getActiveKey(),
  model: 'gemini-2.5-flash',
  maxOutputTokens: 2048,
  temperature: 0.2,
});

// ──────────────────────────────────────────────
// Normalize a LangChain chunk's content to a string
// content can be: string | MessageContent[] | object[]
// ──────────────────────────────────────────────
function extractChunkText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

// ──────────────────────────────────────────────
// Cache key builder
// ──────────────────────────────────────────────
function buildChatCacheKey(messages: any[], videoAMetadata: any, videoBMetadata: any): string {
  const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user')?.content || '';
  const vidAId = videoAMetadata?.id || 'none';
  const vidBId = videoBMetadata?.id || 'none';
  const raw = `${vidAId}:${vidBId}:${lastUserMsg.trim().toLowerCase()}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return cacheKey.chatResponse(hash);
}

// ──────────────────────────────────────────────
// Main SSE chat controller
// ──────────────────────────────────────────────
export const chatStream = async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (payload: object) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  const endResponse = () => {
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };

  // ── Client disconnect handler — abort processing if client leaves ──────
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    console.log('[chat] Client disconnected — aborting stream');
  });

  try {
    const { messages, videoAMetadata, videoBMetadata } = req.body;

    // ── 1. Cache check ─────────────────────────────────────────────────
    const chatCk = buildChatCacheKey(messages, videoAMetadata, videoBMetadata);
    const cachedResponse = await getCached<string>(chatCk);
    if (cachedResponse) {
      console.log('[chat cache HIT] Returning cached response');
      sendEvent({ step: 'Loading from cache...' });
      
      // Send the entire cached response instantly
      sendEvent({ text: cachedResponse });
      sendEvent({ done: true, cached: true });
      return endResponse();
    }

    if (clientDisconnected) return endResponse();

    // ── 2. Run LangGraph agent ─────────────────────────────────────────
    sendEvent({ step: 'Routing query...' });

    const initialState = {
      messages: messages || [],
      videoAMetadata: videoAMetadata || null,
      videoBMetadata: videoBMetadata || null,
    };

    let finalState: any;
    try {
      finalState = await withRetry(
        () => agentGraph.invoke(initialState),
        3, 2000, 'agentGraph.invoke'
      );
    } catch (err: any) {
      const errMsg = err?.message || '';
      const is429 = errMsg.includes('429');
      const retryMatch = errMsg.match(/retry\s+in\s+([\d.]+)s/i);
      const retryAfterSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 60;

      if (is429) {
        sendEvent({
          error: 'rate_limited',
          message: `The AI is rate-limited. Please retry in ${retryAfterSec} seconds.`,
          retryAfter: retryAfterSec,
        });
      } else {
        sendEvent({ error: errMsg || 'Agent graph failed.' });
      }
      return endResponse();
    }

    if (clientDisconnected) return endResponse();

    // ── 3. Stream final LLM response ──────────────────────────────────
    sendEvent({ step: 'Synthesizing response...' });

    const streamMessages = (finalState.messages || []).map((m: any) => ({
      role: m.role,
      content: m.content,
    }));

    let fullResponse = '';

    try {
      const controller = new AbortController();
      let idleTimeoutId: NodeJS.Timeout;

      const resetIdleTimeout = () => {
        clearTimeout(idleTimeoutId);
        idleTimeoutId = setTimeout(() => {
          console.error('[chat] Stream idle timeout (20s) reached. Aborting stream.');
          controller.abort(new Error('Stream hung from Gemini API.'));
        }, 20_000);
      };

      const stream = await withRetry(
        () => getLlm().stream(streamMessages as any, { signal: controller.signal }),
        3, 2000, 'llm.stream'
      );

      resetIdleTimeout();

      for await (const chunk of stream) {
        if (clientDisconnected) break;
        resetIdleTimeout();

        const text = extractChunkText(chunk.content);
        if (text.length > 0) {
          fullResponse += text;
          sendEvent({ text });
        }
      }

      clearTimeout(idleTimeoutId);
    } catch (err: any) {
      const errMsg = err?.message || '';
      const is429 = errMsg.includes('429');
      const retryMatch = errMsg.match(/retry\s+in\s+([\d.]+)s/i);
      const retryAfterSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 60;

      if (is429) {
        sendEvent({
          error: 'rate_limited',
          message: `AI rate limit hit. Please retry in ${retryAfterSec} seconds.`,
          retryAfter: retryAfterSec,
        });
      } else {
        sendEvent({ error: errMsg || 'Failed to stream response.' });
      }
      return endResponse();
    }

    // ── 4. Cache successful response ──────────────────────────────────
    if (!clientDisconnected && fullResponse.length > 20) {
      await setCached(chatCk, fullResponse, TTL.CHAT_RESPONSE).catch(() => {});
      console.log(`[chat cache SET] Response cached (${fullResponse.length} chars)`);
    }

    sendEvent({ done: true });
    endResponse();

  } catch (error: any) {
    console.error('Chat Stream Error:', error);
    const errMsg = error?.message || '';
    const is429 = errMsg.includes('429');
    const retryMatch = errMsg.match(/retry\s+in\s+([\d.]+)s/i);
    const retryAfterSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 60;

    if (is429) {
      sendEvent({
        error: 'rate_limited',
        message: `AI rate limit hit. Please retry in ${retryAfterSec} seconds.`,
        retryAfter: retryAfterSec,
      });
    } else {
      sendEvent({ error: errMsg || 'Failed to process chat request.' });
    }
    endResponse();
  }
};
