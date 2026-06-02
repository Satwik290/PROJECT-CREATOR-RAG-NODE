import { Request, Response, NextFunction } from 'express';
import { downloadAudioAndMetadata } from '../services/youtube.service';
import { transcribeAudio, fetchYoutubeTranscript } from '../services/transcription.service';
import { generateEmbeddings, chunkText } from '../services/embedding.service';
import { storeChunks, deleteChunksForVideo } from '../qdrant/client';
import fs from 'fs';

export const ingestVideo = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { youtubeUrl, instagramUrl } = req.body;

    const processUrl = async (url: string, platform: 'youtube' | 'instagram', videoId: string) => {
      console.log(`Starting ingestion for ${platform} (${videoId}): ${url}`);

      let transcript = '';
      let skipAudio = false;

      // ── Try YouTube caption API first to optimize speed ────────────────
      if (platform === 'youtube') {
        const fastTranscript = await fetchYoutubeTranscript(url);
        if (fastTranscript) {
          transcript = fastTranscript;
          skipAudio = true;
        }
      }

      // ── 1. Scrape metadata (+ optionally download audio) ───────────────
      const { audioPath, metadata } = await downloadAudioAndMetadata(url, platform, skipAudio);

      // ── 2. Delete stale Qdrant chunks before storing fresh ones ─────────
      // This prevents duplicate search results on re-ingest of the same URL
      await deleteChunksForVideo(videoId);

      // ── 3. Transcribe locally if fast transcript was not found ──────────
      if (!transcript) {
        transcript = await transcribeAudio(audioPath);
      }

      // ── 4. Chunk + Embed + Store ─────────────────────────────────────────
      if (transcript && transcript.trim().length > 0) {
        const chunks = chunkText(transcript);
        // Sequential embedding to avoid race conditions on first model load
        const embeddings: number[][] = [];
        for (const chunk of chunks) {
          embeddings.push(await generateEmbeddings(chunk));
        }
        await storeChunks(chunks, embeddings, metadata, videoId);
      } else {
        console.log(`[${videoId}] Empty transcript — storing metadata stub so chat still works.`);
        const stub = `[${videoId}] No spoken content was detected in this ${platform} video.`;
        const stubEmbedding = await generateEmbeddings(stub);
        await storeChunks([stub], [stubEmbedding], metadata, videoId);
      }

      // ── 5. Clean up downloaded audio file to prevent disk exhaustion ────
      try {
        if (fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
          console.log(`[cleanup] Deleted temp audio: ${audioPath}`);
        }
      } catch (cleanupErr: any) {
        console.warn('[cleanup] Could not delete audio file:', cleanupErr?.message?.slice(0, 60));
      }

      console.log(`Finished ingestion for ${platform} (${videoId})`);
      return metadata;
    };

    const promises: Promise<any>[] = [];
    if (youtubeUrl) promises.push(processUrl(youtubeUrl, 'youtube', 'A'));
    if (instagramUrl) promises.push(processUrl(instagramUrl, 'instagram', 'B'));

    if (promises.length === 0) {
      res.status(400).json({ success: false, message: 'No URLs provided' });
      return;
    }

    // Use allSettled so one failure doesn't kill the other
    const settled = await Promise.allSettled(promises);

    const results = settled.map(r => r.status === 'fulfilled' ? r.value : null);
    const errors = settled
      .filter(r => r.status === 'rejected')
      .map(r => (r as PromiseRejectedResult).reason?.message || 'Unknown error');

    if (errors.length > 0) {
      console.error('Partial ingestion errors:', errors);
    }

    // Determine metadataA (YouTube/video A) and metadataB (Instagram/video B)
    let metadataA: any = null;
    let metadataB: any = null;
    if (youtubeUrl && instagramUrl) {
      metadataA = results[0];
      metadataB = results[1];
    } else if (youtubeUrl) {
      metadataA = results[0];
    } else if (instagramUrl) {
      metadataB = results[0];
    }

    res.status(200).json({
      success: true,
      message: errors.length > 0
        ? `Ingestion completed with warnings: ${errors.join('; ')}`
        : 'Ingestion completed.',
      metadataA,
      metadataB,
    });

  } catch (error) {
    console.error('Fatal ingest error:', error);
    res.status(500).json({ success: false, message: 'Ingestion failed unexpectedly.' });
  }
};
