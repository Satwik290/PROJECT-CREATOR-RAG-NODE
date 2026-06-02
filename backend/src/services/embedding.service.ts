import { pipeline } from '@xenova/transformers';

let extractor: any = null;

export const initEmbeddingModel = async (): Promise<void> => {
  if (!extractor) {
    console.log("Loading local BGE embedding model (Xenova/bge-small-en-v1.5)...");
    extractor = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
    console.log("BGE embedding model loaded successfully.");
  }
};

export const generateEmbeddings = async (text: string): Promise<number[]> => {
  await initEmbeddingModel();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

export const chunkText = (text: string, chunkSize: number = 200, overlap: number = 40): string[] => {
  // Simple word-based chunker
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  let i = 0;
  while (i < words.length) {
    const chunkWords = words.slice(i, i + chunkSize);
    chunks.push(chunkWords.join(' '));
    i += chunkSize - overlap;
  }
  
  return chunks;
};
