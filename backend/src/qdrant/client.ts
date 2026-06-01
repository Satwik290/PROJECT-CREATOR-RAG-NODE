import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../config/env';
import { VideoMetadata } from '../services/youtube.service';
import crypto from 'crypto';

export const qdrant = new QdrantClient({ url: env.QDRANT_URL });
export const COLLECTION_NAME = 'video_transcripts';

export const initializeQdrant = async () => {
  try {
    const collections = await qdrant.getCollections();
    const exists = collections.collections.some(c => c.name === COLLECTION_NAME);

    if (!exists) {
      await qdrant.createCollection(COLLECTION_NAME, {
        vectors: {
          size: 384, // bge-small-en-v1.5 produces 384-d vectors
          distance: 'Cosine',
        },
      });
      console.log(`Qdrant Collection '${COLLECTION_NAME}' created.`);
    }
  } catch (error) {
    console.error('Qdrant Initialization Error:', error);
    // Non-fatal — server continues, searches will fail gracefully
  }
};

// ──────────────────────────────────────────────
// Delete all existing chunks for a videoId before re-ingesting
// Prevents duplicate chunks accumulating on every re-ingest
// ──────────────────────────────────────────────
export const deleteChunksForVideo = async (videoId: string): Promise<void> => {
  try {
    await qdrant.delete(COLLECTION_NAME, {
      filter: {
        must: [{ key: 'videoId', match: { value: videoId } }],
      },
      wait: true,
    });
    console.log(`[Qdrant] Deleted existing chunks for videoId='${videoId}'`);
  } catch (err: any) {
    // Non-fatal — old chunks may persist but won't break the pipeline
    console.warn('[Qdrant] Could not delete old chunks:', err?.message?.slice(0, 80));
  }
};

export const storeChunks = async (
  chunks: string[],
  embeddings: number[][],
  metadata: VideoMetadata,
  videoId: string
) => {
  // Use SHA-256 → UUID format for deterministic point IDs
  // This prevents duplicate chunks accumulating on re-ingest of the same URL
  const pointsWithUUIDs = chunks.map((chunk, index) => {
    const hash = crypto.createHash('sha256').update(`${videoId}:chunk:${index}`).digest('hex');
    // Format as UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuid = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      '4' + hash.slice(13, 16),
      ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
      hash.slice(20, 32),
    ].join('-');
    return {
      id: uuid,
      vector: embeddings[index],
      payload: {
        ...metadata,
        text: chunk,
        chunkIndex: index,
        videoId,
      },
    };
  });

  try {
    await qdrant.upsert(COLLECTION_NAME, {
      wait: true,
      points: pointsWithUUIDs,
    });
    console.log(`[Qdrant] Stored ${pointsWithUUIDs.length} chunks for videoId='${videoId}'`);
  } catch (err: any) {
    console.error('[Qdrant] storeChunks failed:', err?.message?.slice(0, 120));
    throw err; // let ingest controller handle it via Promise.allSettled
  }
};

export const searchSimilarChunks = async (
  queryEmbedding: number[],
  filterField?: 'id' | 'platform' | 'videoId',
  filterValue?: string
) => {
  const filter =
    filterField && filterValue
      ? {
          must: [{ key: filterField, match: { value: filterValue } }],
        }
      : undefined;

  try {
    const result = await qdrant.search(COLLECTION_NAME, {
      vector: queryEmbedding,
      limit: 6,
      filter,
      with_payload: true,
    });
    return result;
  } catch (err: any) {
    console.error('[Qdrant] searchSimilarChunks failed:', err?.message?.slice(0, 120));
    return []; // graceful fallback — chat continues with empty context
  }
};
