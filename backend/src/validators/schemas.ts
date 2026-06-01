import { z } from 'zod';

export const ingestSchema = z.object({
  body: z.object({
    youtubeUrl: z.string().url('Invalid YouTube URL').optional(),
    instagramUrl: z.string().url('Invalid Instagram URL').optional(),
  }).refine(data => data.youtubeUrl || data.instagramUrl, {
    message: "At least one of youtubeUrl or instagramUrl must be provided",
    path: ['youtubeUrl']
  })
});

// Accept messages array + optional metadata objects from frontend
export const chatSchema = z.object({
  body: z.object({
    messages: z.array(
      z.object({
        role: z.string(),
        content: z.string(),
      })
    ).min(1, 'At least one message is required'),
    videoAMetadata: z.any().optional(),
    videoBMetadata: z.any().optional(),
  })
});
