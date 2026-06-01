import Redis from 'ioredis';
import { env } from '../config/env';

// ──────────────────────────────────────────────
// Redis client — fails gracefully if Redis is not running
// ──────────────────────────────────────────────
let redis: Redis | null = null;
let redisAvailable = false;

const createRedisClient = () => {
  try {
    const client = new Redis(env.REDIS_URL, {
      connectTimeout: 3000,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 3) return null; // Give up after 3 attempts
        return Math.min(times * 500, 2000);
      },
    });

    client.on('connect', () => {
      redisAvailable = true;
      console.log('✅ Redis connected successfully');
    });

    client.on('error', (err) => {
      if (redisAvailable) {
        console.warn('⚠️  Redis connection lost — continuing without cache:', err.message);
      }
      redisAvailable = false;
    });

    client.on('close', () => {
      redisAvailable = false;
    });

    client.connect().catch(() => {
      console.warn('⚠️  Redis not available — caching disabled. Start Redis via docker-compose up -d');
    });

    return client;
  } catch (err) {
    console.warn('⚠️  Failed to initialize Redis client:', err);
    return null;
  }
};

redis = createRedisClient();

// ──────────────────────────────────────────────
// TTL Constants
// ──────────────────────────────────────────────
export const TTL = {
  METADATA: 60 * 60,          // 1 hour — social media stats
  CHAT_RESPONSE: 60 * 60 * 6, // 6 hours — LLM responses
  GEMINI_CALL: 60 * 30,       // 30 min — Gemini API results
};

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
export const getCached = async <T>(key: string): Promise<T | null> => {
  if (!redis || !redisAvailable) return null;
  try {
    const val = await redis.get(key);
    if (!val) return null;
    return JSON.parse(val) as T;
  } catch {
    return null;
  }
};

export const setCached = async (key: string, value: unknown, ttlSeconds: number): Promise<void> => {
  if (!redis || !redisAvailable) return;
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // Silently fail — cache is best-effort
  }
};

export const deleteCached = async (key: string): Promise<void> => {
  if (!redis || !redisAvailable) return;
  try {
    await redis.del(key);
  } catch {
    // Silently fail
  }
};

export const isRedisUp = () => redisAvailable;

// ──────────────────────────────────────────────
// Key builders
// ──────────────────────────────────────────────
export const cacheKey = {
  metadata: (url: string) => `metadata:${Buffer.from(url).toString('base64').slice(0, 64)}`,
  chatResponse: (queryHash: string) => `chat:${queryHash}`,
  geminiSearch: (url: string, platform: string) =>
    `gemini:${platform}:${Buffer.from(url).toString('base64').slice(0, 64)}`,
};
