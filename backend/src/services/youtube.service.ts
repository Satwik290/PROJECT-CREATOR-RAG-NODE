import youtubeDl from 'youtube-dl-exec';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import ffmpegPath from 'ffmpeg-static';
import { env } from '../config/env';
import { getCached, setCached, cacheKey, TTL } from './cache.service';
import { apiKeyManager } from './key.service';

export interface VideoMetadata {
  id: string;
  title: string;
  views: number;
  likes: number;
  comments: number;
  engagementRate: number;
  creator: string;
  followerCount: number;
  hashtags: string[];
  uploadDate: string;
  duration: number;
  platform: 'youtube' | 'instagram';
  dataSource?: 'scraped' | 'estimated' | 'cached';
}

// ──────────────────────────────────────────────
// Utility: Parse abbreviated numbers "1.2M", "500K", "3.5B", "1,234,567"
// ──────────────────────────────────────────────
const parseAbbreviated = (val: any): number => {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return Math.round(val);
  const str = String(val).replace(/,/g, '').trim();
  const match = str.match(/^([\d.]+)\s*([KkMmBbTt]?)/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const suffix = (match[2] || '').toUpperCase();
  if (suffix === 'K') return Math.round(num * 1_000);
  if (suffix === 'M') return Math.round(num * 1_000_000);
  if (suffix === 'B') return Math.round(num * 1_000_000_000);
  if (suffix === 'T') return Math.round(num * 1_000_000_000_000);
  return Math.round(num);
};

// ──────────────────────────────────────────────
// Utility: Write silent WAV so pipeline never crashes
// ──────────────────────────────────────────────
const writeSilentWav = (filePath: string) => {
  const sr = 8000, ch = 1, bps = 16, dur = 3;
  const bytesPS = bps / 8;
  const dataSize = sr * ch * bytesPS * dur;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);      h.writeUInt32LE(36 + dataSize, 4);
  h.write('WAVE', 8);      h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * ch * bytesPS, 28);
  h.writeUInt16LE(ch * bytesPS, 32); h.writeUInt16LE(bps, 34);
  h.write('data', 36);     h.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, Buffer.concat([h, Buffer.alloc(dataSize)]));
};

// ──────────────────────────────────────────────
// Utility: Exponential backoff retry
// ──────────────────────────────────────────────
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 2000,
  label = 'operation'
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const errMsg = err?.message || String(err);
      const is429 = errMsg.includes('429') || err?.status === 429;
      const isNetwork = err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT' || errMsg.includes('abort');

      if (attempt < maxRetries && (is429 || isNetwork)) {
        // Parse retry-after from error message (e.g. "retry in 53.6s")
        const retryMatch = errMsg.match(/retry\s+in\s+([\d.]+)s/i);
        const retryAfterMs = retryMatch
          ? Math.ceil(parseFloat(retryMatch[1])) * 1000
          : baseDelayMs * Math.pow(2, attempt); // exponential: 2s, 4s, 8s

        if (is429 && apiKeyManager.getKeyCount() > 1) {
          // Rotate key with the cooldown from the API response
          console.warn(`[retry] ${label} attempt ${attempt + 1}/${maxRetries} hit 429. Rotating API key...`);
          apiKeyManager.rotate(retryAfterMs);
          // Retry immediately with the new key — no wait
          continue;
        }

        const waitSec = Math.round(retryAfterMs / 1000);
        console.warn(`[retry] ${label} attempt ${attempt + 1}/${maxRetries} failed (${is429 ? '429' : err?.code}). Waiting ${waitSec}s...`);
        await sleep(retryAfterMs);
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

const fetchWithTimeout = async (url: string, opts: RequestInit, timeoutMs = 10_000): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
};

// ──────────────────────────────────────────────
// YouTube oEmbed — public, no auth, always works for public videos
// ──────────────────────────────────────────────
const fetchYouTubeOEmbed = async (url: string): Promise<{ title: string; creator: string } | null> => {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      {},
      8_000
    );
    if (res.ok) {
      const data: any = await res.json();
      return { title: data.title || '', creator: data.author_name || '' };
    }
  } catch { /* ignore */ }
  return null;
};

// ──────────────────────────────────────────────
// Instagram scraper via yt-dlp (cookie-less, prototype mode)
// Falls back to lightweight HTML scrape for public profiles
// ──────────────────────────────────────────────
// Instagram scraper — cascading strategy waterfall
//   0. RapidAPI Instagram Web Scraper (best quality, requires RAPIDAPI_KEY)
//   1. Session cookie authenticated API (requires INSTAGRAM_SESSION_ID)
//   2. yt-dlp (often blocked but works for some public reels)
//   3. HTML OG meta-tag scrape (last resort, no view count)
// ──────────────────────────────────────────────
const scrapeInstagramMeta = async (url: string): Promise<{
  title: string; creator: string; views: number; likes: number; comments: number; followerCount: number;
}> => {
  const empty = { title: 'Instagram Reel', creator: '', views: 0, likes: 0, comments: 0, followerCount: 0 };
  const shortcode = url.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/)?.[1];

  // ── Strategy 0: RapidAPI Instagram Web Scraper ───────────────────────
  // Sign up at https://rapidapi.com/social-api1-instagram/api/instagram-scraper-api2
  // Free tier: 50 requests/month. Paid plans start at $0.001/request.
  if (shortcode && process.env.RAPIDAPI_KEY) {
    try {
      console.log('[Instagram] Strategy 0: RapidAPI Instagram scraper...');
      const res = await fetchWithTimeout(
        `https://instagram-scraper-api2.p.rapidapi.com/v1/post_info?code_or_id_or_url=${encodeURIComponent(url)}`,
        {
          headers: {
            'x-rapidapi-host': 'instagram-scraper-api2.p.rapidapi.com',
            'x-rapidapi-key': process.env.RAPIDAPI_KEY,
          },
        },
        10_000
      );
      if (res.ok) {
        const json: any = await res.json();
        const d = json?.data;
        if (d && (d.owner?.username || d.caption_text)) {
          const result = {
            title: d.caption_text?.slice(0, 100) || d.accessibility_caption || 'Instagram Reel',
            creator: d.owner?.username || d.user?.username || '',
            views: d.video_view_count || d.play_count || d.view_count || 0,
            likes: d.like_count || d.likes?.count || 0,
            comments: d.comment_count || d.comments?.count || 0,
            followerCount: d.owner?.follower_count || d.user?.follower_count || 0,
          };
          console.log(`[Instagram Strategy 0 ✅ RapidAPI] creator="${result.creator}" views=${result.views} likes=${result.likes}`);
          return result;
        }
        console.warn('[Instagram Strategy 0] RapidAPI returned empty data:', JSON.stringify(json).slice(0, 200));
      } else {
        const errBody = await res.text().catch(() => '');
        console.warn(`[Instagram Strategy 0] RapidAPI HTTP ${res.status}:`, errBody.slice(0, 120));
      }
    } catch (err: any) {
      console.warn('[Instagram Strategy 0] RapidAPI failed:', err.message?.slice(0, 100));
    }
  }

  // ── Strategy 1: Authenticated session cookie API ─────────────────────
  if (shortcode && process.env.INSTAGRAM_SESSION_ID) {
    try {
      console.log('[Instagram] Strategy 1: Session Cookie API...');
      const res = await fetchWithTimeout(
        `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`,
        {
          headers: {
            'Cookie': `sessionid=${process.env.INSTAGRAM_SESSION_ID}`,
            'User-Agent': 'Instagram 219.0.0.12.117 Android',
          },
        },
        8000
      );
      if (res.ok) {
        const data: any = await res.json();
        const item = data?.graphql?.shortcode_media || data?.items?.[0];
        if (item) {
          const result = {
            title: item.accessibility_caption || item.caption?.text?.slice(0, 80) || 'Instagram Reel',
            creator: item.owner?.username || '',
            views: item.video_view_count || item.play_count || 0,
            likes: item.edge_media_preview_like?.count || item.like_count || 0,
            comments: item.edge_media_to_comment?.count || item.comment_count || 0,
            followerCount: item.owner?.edge_followed_by?.count || 0,
          };
          console.log(`[Instagram Strategy 1 ✅ Session] creator="${result.creator}" views=${result.views}`);
          return result;
        }
      } else {
        console.warn(`[Instagram Strategy 1] Session API HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.warn('[Instagram Strategy 1] Session scrape failed:', err.message?.slice(0, 80));
    }
  }

  // ── Strategy 2: yt-dlp with Instagram-specific user-agent ────────────
  try {
    console.log('[Instagram] Strategy 2: yt-dlp...');
    const raw: any = await youtubeDl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      addHeader: [
        'user-agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept-Language:en-US,en;q=0.9',
      ],
    });

    if (raw && (raw.title || raw.uploader)) {
      console.log(`[Instagram Strategy 2 ✅ yt-dlp] title="${raw.title}" creator="${raw.uploader}" views=${raw.view_count}`);
      return {
        title: raw.title || raw.description?.slice(0, 80) || 'Instagram Reel',
        creator: raw.uploader || raw.channel || raw.uploader_id || '',
        views: raw.view_count || 0,
        likes: raw.like_count || 0,
        comments: raw.comment_count || 0,
        followerCount: raw.channel_follower_count || 0,
      };
    }
  } catch (err: any) {
    console.warn('[Instagram Strategy 2] yt-dlp blocked/failed:', err.message?.slice(0, 120));
  }

  // ── Strategy 3: HTML OG meta-tag scrape ──────────────────────────────
  try {
    console.log('[Instagram] Strategy 3: HTML OG scrape...');
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    }, 10_000);

    if (res.ok) {
      const html = await res.text();
      const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1] || '';
      const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)?.[1] || '';
      const descMatch = ogDesc.match(/^([\d,KkMm.]+)\s+likes?,\s+([\d,KkMm.]+)\s+comments?\s*[-–]\s*(.+)$/i);
      const likesFromDesc = descMatch ? parseAbbreviated(descMatch[1]) : 0;
      const commentsFromDesc = descMatch ? parseAbbreviated(descMatch[2]) : 0;
      const creatorFromDesc = descMatch ? descMatch[3].trim() : '';
      const urlCreator = url.match(/instagram\.com\/([^/?]+)\//)?.[1] || '';

      if (ogTitle || creatorFromDesc) {
        console.log(`[Instagram Strategy 3 ✅ HTML] title="${ogTitle}" creator="${creatorFromDesc || urlCreator}"`);
        return {
          title: ogTitle || 'Instagram Reel',
          creator: creatorFromDesc || urlCreator || '',
          views: 0,
          likes: likesFromDesc,
          comments: commentsFromDesc,
          followerCount: 0,
        };
      }
    }
  } catch (err: any) {
    console.warn('[Instagram Strategy 3] HTML scrape failed:', err.message?.slice(0, 120));
  }

  console.warn('[Instagram] All 4 strategies failed — using empty fallback. Set RAPIDAPI_KEY in .env for reliable data.');
  return empty;
};


// ──────────────────────────────────────────────
// Gemini Google Search grounding — get real-time social metrics
// Wrapped with Redis cache + exponential backoff retry
// ──────────────────────────────────────────────
const fetchMetadataViaGemini = async (
  url: string,
  platform: 'youtube' | 'instagram',
  hints: { title?: string; creator?: string; likes?: number; comments?: number }
): Promise<{
  title: string; creatorName: string; followers: number;
  views: number; likes: number; comments: number;
}> => {
  const fallback = {
    title: hints.title || '',
    creatorName: hints.creator || '',
    followers: 0, views: 0,
    likes: hints.likes || 0,
    comments: hints.comments || 0,
  };

  // Check Redis cache first
  const ck = cacheKey.geminiSearch(url, platform);
  const cached = await getCached<typeof fallback>(ck);
  if (cached) {
    console.log(`[Gemini cache HIT] ${platform} metadata for ${url.slice(-30)}`);
    return cached;
  }

  const hintText = [
    hints.title ? `Known title: "${hints.title}"` : '',
    hints.creator ? `Known creator: "${hints.creator}"` : '',
    hints.likes ? `Known likes: ${hints.likes}` : '',
  ].filter(Boolean).join('. ');

  const prompt = `You are a social media analytics researcher with internet access.
  
Search Google RIGHT NOW for real statistics of this ${platform} video:
URL: ${url}
${hintText}

I need EXACT numbers (not ranges) for:
- Video/post title
- Creator/channel name  
- Total view count (how many times the video has been watched)
- Creator's total follower/subscriber count
- Like count on this specific video
- Comment count on this specific video

CRITICAL: 
- Search for the specific video stats, not channel overview
- If you find numbers like "1.2 million views", return as 1200000
- If you cannot find a number, return 0
- Do NOT estimate or guess, only use what Google search results show

Return ONLY this JSON object, no other text:
{
  "title": "exact title here",
  "creatorName": "exact creator name",
  "views": 0,
  "followers": 0,
  "likes": 0,
  "comments": 0
}`;

  try {
    const result = await withRetry(
      async () => {
        const activeKey = apiKeyManager.getActiveKey();
        // 25-second timeout — prevents indefinite hangs on slow Gemini responses
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25_000);
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${activeKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller.signal,
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                tools: [{ google_search: {} }],
                generationConfig: { temperature: 0, maxOutputTokens: 512 }
              })
            }
          );
          const data: any = await res.json();
          if (!res.ok) {
            const errMsg = JSON.stringify(data).slice(0, 300);
            throw new Error(`Gemini API ${res.status}: ${errMsg}`);
          }
          return data;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      3,       // max 3 retries
      2000,    // base delay 2s → 4s → 8s
      `Gemini metadata (${platform})`
    );

    let text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`[Gemini ${platform}] raw response:`, text.slice(0, 300));

    text = text.replace(/^```(?:json)?\s*/im, '').replace(/\s*```$/m, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[Gemini] No JSON found in response');
      return fallback;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const finalResult = {
      title: parsed.title || hints.title || '',
      creatorName: parsed.creatorName || parsed.creator || hints.creator || '',
      followers: parseAbbreviated(parsed.followers),
      views: parseAbbreviated(parsed.views),
      likes: parseAbbreviated(parsed.likes) || hints.likes || 0,
      comments: parseAbbreviated(parsed.comments) || hints.comments || 0,
    };

    // Cache successful result
    await setCached(ck, finalResult, TTL.GEMINI_CALL);
    console.log(`[Gemini cache SET] ${platform} metadata cached for 30 min`);

    return finalResult;
  } catch (err) {
    console.error('[Gemini] metadata fetch error after retries:', (err as any)?.message?.slice(0, 150));
    return fallback;
  }
};

// ──────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────
export const downloadAudioAndMetadata = async (
  url: string,
  platform: 'youtube' | 'instagram',
  skipAudio = false
): Promise<{ audioPath: string; metadata: VideoMetadata }> => {

  const outputId = crypto.randomUUID();
  const downloadsDir = path.join(__dirname, '../../downloads');
  const outputPath = path.join(downloadsDir, `${outputId}.%(ext)s`);
  const finalAudioPath = path.join(downloadsDir, `${outputId}.wav`);

  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

  // ── Check metadata cache first ───────────────────────────────────────
  const metaCk = cacheKey.metadata(url);
  const cachedMeta = await getCached<VideoMetadata>(metaCk);
  if (cachedMeta) {
    console.log(`[cache HIT] Metadata for ${url.slice(-40)} — skipping scrape`);
    if (skipAudio) {
      writeSilentWav(finalAudioPath);
      return { audioPath: finalAudioPath, metadata: { ...cachedMeta, dataSource: 'cached' } };
    }
    // Still need to download audio (no audio cache)
    let audioOk = false;
    try {
      await youtubeDl(url, {
        extractAudio: true, audioFormat: 'wav', output: outputPath,
        ffmpegLocation: ffmpegPath || undefined,
        noCheckCertificates: true, noWarnings: true,
        addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
      });
      audioOk = fs.existsSync(finalAudioPath);
    } catch { /* audio fallback below */ }
    if (!audioOk || !fs.existsSync(finalAudioPath)) writeSilentWav(finalAudioPath);
    return { audioPath: finalAudioPath, metadata: { ...cachedMeta, dataSource: 'cached' } };
  }

  // ── 1. Platform-specific metadata scraping ────────────────────────────
  let title = '';
  let views = 0;
  let likes = 0;
  let comments = 0;
  let creator = '';
  let followerCount = 0;
  let hashtags: string[] = [];
  let uploadDate = '';
  let duration = 0;
  let rawId = outputId;
  let dataSource: VideoMetadata['dataSource'] = 'scraped';

  if (platform === 'instagram') {
    // Instagram: use dedicated scraper (yt-dlp + HTML fallback)
    const igMeta = await scrapeInstagramMeta(url);
    title = igMeta.title;
    creator = igMeta.creator;
    views = igMeta.views;
    likes = igMeta.likes;
    comments = igMeta.comments;
    followerCount = igMeta.followerCount;
  } else {
    // YouTube: use yt-dlp
    try {
      const rawMetadata: any = await youtubeDl(url, {
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
      });
      console.log(`[yt-dlp] Got metadata: title="${rawMetadata?.title}" views=${rawMetadata?.view_count}`);
      title = rawMetadata?.title || '';
      views = rawMetadata?.view_count || 0;
      likes = rawMetadata?.like_count || 0;
      comments = rawMetadata?.comment_count || 0;
      creator = rawMetadata?.uploader || rawMetadata?.channel || '';
      followerCount = rawMetadata?.channel_follower_count || 0;
      hashtags = rawMetadata?.tags || [];
      uploadDate = rawMetadata?.upload_date || '';
      duration = rawMetadata?.duration || 0;
      rawId = rawMetadata?.id || outputId;
    } catch {
      console.warn(`yt-dlp blocked for YouTube ${url}. Using API fallbacks.`);
    }

    // YouTube oEmbed for title/creator when yt-dlp fails
    if (!title || !creator) {
      const oembed = await fetchYouTubeOEmbed(url);
      if (oembed) {
        if (!title) title = oembed.title;
        if (!creator) creator = oembed.creator;
        console.log(`[oEmbed] title="${title}" creator="${creator}"`);
      }
    }
  }

  // ── 2. Gemini grounding for any missing metric ────────────────────────
  // (cached + retry logic lives inside fetchMetadataViaGemini)
  const anyMissing = views === 0 || followerCount === 0 || !title || !creator;
  if (anyMissing) {
    console.log(`Fetching verified metrics via Gemini for ${platform}…`);
    const gemini = await fetchMetadataViaGemini(url, platform, { title, creator, likes, comments });

    if (!title && gemini.title) title = gemini.title;
    if (!creator && gemini.creatorName) creator = gemini.creatorName;
    if (views === 0 && gemini.views > 0) views = gemini.views;
    if (followerCount === 0 && gemini.followers > 0) followerCount = gemini.followers;
    if (likes === 0 && gemini.likes > 0) likes = gemini.likes;
    if (comments === 0 && gemini.comments > 0) comments = gemini.comments;
  }

  // ── 3. Last resort estimation (only if all above failed) ──────────────
  if (views === 0 && likes > 0) {
    const avgEng = platform === 'youtube' ? 0.03 : 0.04;
    views = Math.round(likes / avgEng);
    dataSource = 'estimated';
    console.log(`[estimate] views estimated from likes: ${views}`);
  }
  if (followerCount === 0 && views > 0) {
    followerCount = Math.round(views * 3);
    dataSource = 'estimated';
    console.log(`[estimate] followerCount estimated: ${followerCount}`);
  }

  const engagementRate = views > 0 ? ((likes + comments) / views) * 100 : 0;

  const metadata: VideoMetadata = {
    id: rawId,
    title: title || (platform === 'instagram' ? 'Instagram Reel' : 'YouTube Short'),
    views, likes, comments, engagementRate,
    creator: creator || 'Unknown Creator',
    followerCount, hashtags,
    uploadDate: uploadDate || new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    duration, platform, dataSource,
  };

  // Cache the metadata result for 1 hour
  await setCached(metaCk, metadata, TTL.METADATA);
  console.log(`[cache SET] Metadata cached for ${url.slice(-40)}`);

  if (skipAudio) {
    writeSilentWav(finalAudioPath);
    return { audioPath: finalAudioPath, metadata };
  }

  // ── 4. Download Audio ─────────────────────────────────────────────────
  let audioOk = false;
  const platformHeaders = platform === 'instagram'
    ? ['referer:https://www.instagram.com/', 'user-agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15']
    : ['referer:youtube.com', 'user-agent:Mozilla/5.0'];

  try {
    await youtubeDl(url, {
      extractAudio: true, audioFormat: 'wav', output: outputPath,
      ffmpegLocation: ffmpegPath || undefined,
      noCheckCertificates: true, noWarnings: true,
      addHeader: platformHeaders,
    });
    // Check for .wav first, then fall back to any audio file yt-dlp might have produced
    if (fs.existsSync(finalAudioPath)) {
      audioOk = true;
    } else {
      // yt-dlp might have saved with a different extension — find it
      const files = fs.readdirSync(downloadsDir).filter(f => f.startsWith(outputId));
      if (files.length > 0) {
        const altPath = path.join(downloadsDir, files[0]);
        fs.renameSync(altPath, finalAudioPath); // normalize to .wav name
        audioOk = fs.existsSync(finalAudioPath);
      }
    }
  } catch {
    try {
      await youtubeDl(url, {
        extractAudio: true, audioFormat: 'wav', output: outputPath,
        ffmpegLocation: ffmpegPath || undefined,
        noCheckCertificates: true, noWarnings: true,
      });
      audioOk = fs.existsSync(finalAudioPath);
    } catch {
      console.warn(`Audio blocked for ${platform}. Using silent WAV fallback.`);
    }
  }

  if (!audioOk || !fs.existsSync(finalAudioPath)) writeSilentWav(finalAudioPath);
  return { audioPath: finalAudioPath, metadata };
};
