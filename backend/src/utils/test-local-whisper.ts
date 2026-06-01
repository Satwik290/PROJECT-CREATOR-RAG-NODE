import { pipeline } from '@xenova/transformers';
import { WaveFile } from 'wavefile';
import fs from 'fs';
import path from 'path';

async function test() {
  console.log("Xenova transformers loaded");
  try {
    const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
    console.log("Whisper tiny pipeline loaded successfully");
  } catch (e: any) {
    console.error("Error loading pipeline:", e);
  }
}

test();
