import fs from 'fs';
import { pipeline } from '@xenova/transformers';
import { WaveFile } from 'wavefile';

let transcriber: any = null;

const initTranscriber = async () => {
  if (!transcriber) {
    console.log("Loading local Whisper model (Xenova/whisper-tiny)...");
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
    console.log("Whisper model loaded successfully.");
  }
  return transcriber;
};

export const transcribeAudio = async (audioPath: string): Promise<string> => {
  try {
    const model = await initTranscriber();

    console.log(`Reading audio file from ${audioPath}...`);
    const buffer = fs.readFileSync(audioPath);
    const wav = new WaveFile(buffer);
    
    // Whisper requires 16kHz, mono, 32-bit float audio
    wav.toBitDepth('32f');
    wav.toSampleRate(16000);
    
    let audioData = wav.getSamples();
    
    // Handle stereo: extract left channel or average channels
    if (Array.isArray(audioData)) {
      if (audioData.length > 1) {
        const SCALING_FACTOR = Math.sqrt(2);
        const mono = new Float32Array(audioData[0].length);
        for (let i = 0; i < audioData[0].length; ++i) {
          mono[i] = SCALING_FACTOR * (audioData[0][i] + audioData[1][i]) / 2;
        }
        audioData = mono;
      } else {
        audioData = audioData[0];
      }
    }

    console.log(`Transcribing audio locally...`);
    const result = await model(audioData, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false
    });
    
    const text = result.text || '';
    console.log(`Transcription complete (${text.length} chars)`);
    return text;
  } catch (error: any) {
    console.error(`Local transcription error:`, error?.message?.slice(0, 200));
    return '';
  }
};
