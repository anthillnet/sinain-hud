/**
 * Bigram-based text deduplication for audio transcripts.
 * Prevents repetitive audio (music, TV, looping sounds) from
 * filling the context buffer with near-identical entries.
 */

/** Extract character bigrams from text, lowercased. */
function bigrams(text: string): Set<string> {
  const s = text.toLowerCase().trim();
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

/** Dice coefficient similarity between two strings (0.0–1.0). */
export function bigramSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 1.0;
  if (ba.size === 0 || bb.size === 0) return 0.0;
  let intersection = 0;
  for (const bg of ba) {
    if (bb.has(bg)) intersection++;
  }
  return (2 * intersection) / (ba.size + bb.size);
}

/**
 * Check if a transcript is a near-duplicate of recent transcripts.
 * Returns true if similarity > threshold against any of the recent entries.
 */
export function isDuplicateTranscript(
  text: string,
  recentTexts: string[],
  threshold = 0.80,
): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 5) return false; // Don't dedup very short text
  for (const recent of recentTexts) {
    if (bigramSimilarity(trimmed, recent) > threshold) {
      return true;
    }
  }
  return false;
}
