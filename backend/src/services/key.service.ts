import { env } from '../config/env';

// ──────────────────────────────────────────────
// Generic API Key Rotation Manager
// Supports comma-separated keys in any env var.
// Tracks per-key 429 cooldown so exhausted keys
// are skipped until their cooldown expires.
// ──────────────────────────────────────────────
class ApiKeyManager {
  private keys: string[] = [];
  private currentIndex = 0;
  private cooldowns: Map<number, number> = new Map(); // index → expiry timestamp ms
  private label: string;

  constructor(rawKeys: string, label: string) {
    this.label = label;
    this.keys = rawKeys
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);

    if (this.keys.length === 0) {
      console.warn(`⚠️  [${label}] No API keys found!`);
    } else {
      console.log(`[${label}] Initialized with ${this.keys.length} key(s)`);
    }
  }

  // Returns the currently active non-cooled-down key (or falls back to oldest)
  public getActiveKey(): string {
    if (this.keys.length === 0) return '';
    // Find an available key starting from currentIndex
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.currentIndex + i) % this.keys.length;
      const cooldownExp = this.cooldowns.get(idx) || 0;
      if (Date.now() >= cooldownExp) {
        this.currentIndex = idx;
        return this.keys[idx];
      }
    }
    // All keys on cooldown — return the one whose cooldown expires soonest
    let minCooldown = Infinity;
    let minIdx = this.currentIndex;
    this.cooldowns.forEach((exp, idx) => {
      if (exp < minCooldown) { minCooldown = exp; minIdx = idx; }
    });
    console.warn(`[${this.label}] All keys are on cooldown. Using soonest-available key (index ${minIdx}).`);
    return this.keys[minIdx];
  }

  // Rotate to the next available key (not on cooldown). Returns the new key.
  public rotate(cooldownMs = 0): string {
    if (this.keys.length <= 1) return this.getActiveKey();

    // Mark the current key as cooled down if a cooldown is provided
    if (cooldownMs > 0) {
      this.cooldowns.set(this.currentIndex, Date.now() + cooldownMs);
      console.warn(`[${this.label}] Key index ${this.currentIndex} placed on ${Math.round(cooldownMs / 1000)}s cooldown.`);
    }

    // Find the next available key
    for (let i = 1; i <= this.keys.length; i++) {
      const idx = (this.currentIndex + i) % this.keys.length;
      const cooldownExp = this.cooldowns.get(idx) || 0;
      if (Date.now() >= cooldownExp) {
        this.currentIndex = idx;
        console.log(`[${this.label}] 🔄 Rotated to key index ${this.currentIndex}`);
        return this.keys[this.currentIndex];
      }
    }

    // All keys on cooldown — just advance anyway
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    console.warn(`[${this.label}] All keys exhausted. Using key index ${this.currentIndex}.`);
    return this.keys[this.currentIndex];
  }

  public getKeyCount(): number {
    return this.keys.length;
  }
}

// ── Gemini key manager ──────────────────────────
export const apiKeyManager = new ApiKeyManager(
  env.GEMINI_API_KEY || '',
  'Gemini API Key Manager'
);

