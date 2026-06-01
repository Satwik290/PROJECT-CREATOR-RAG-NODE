import { WaveFile } from 'wavefile';

try {
  const wav = new WaveFile();
  console.log("✅ WaveFile imported and instantiated successfully!");
} catch (e: any) {
  console.error("❌ WaveFile failed:", e);
}
