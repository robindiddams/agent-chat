/**
 * Yonkers-Style Name Generator
 *
 * Generates fun Italian-American neighborhood-style names
 * for agents instead of boring random hashes.
 */

const BASE_NAMES = [
  "louey",
  "johnny",
  "paully",
  "vinnie",
  "frankie",
  "tony",
  "sal",
  "gino",
  "rocco",
  "donnie",
  "mikey",
  "nicky",
  "carmine",
  "joey",
  "richie",
  "bobby",
  "enzo",
  "carlo",
  "petey",
  "eddie",
  "sammy",
  "dominic",
  "lenny",
  "vito",
  "sonny",
  "marco",
  "dino",
  "cosmo",
  "ralphie",
  "bruno",
] as const;

const PREFIXES = [
  "big",
  "lil",
  "lucky",
  "slick",
  "two-tone",
  "fast",
  "sweet",
] as const;

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a random Yonkers-style name.
 * Returns a simple base name like "louey" or "rocco".
 */
export function generateName(): string {
  return pickRandom(BASE_NAMES);
}

/**
 * Generate a unique name that isn't in the `taken` set.
 *
 * Strategy:
 *   1. Try plain base names first (shuffled)
 *   2. If all taken, combine prefix + base name ("big-louey", "lil-johnny")
 *   3. Should always find something — 30 bases x 7 prefixes = 210+ combos
 */
export function generateFallbackName(taken: Set<string>): string {
  // Shuffle base names and try each one
  const shuffled = [...BASE_NAMES].sort(() => Math.random() - 0.5);

  for (const name of shuffled) {
    if (!taken.has(name)) return name;
  }

  // All base names taken — try prefix combos
  const shuffledPrefixes = [...PREFIXES].sort(() => Math.random() - 0.5);

  for (const prefix of shuffledPrefixes) {
    for (const name of shuffled) {
      const combo = `${prefix}-${name}`;
      if (!taken.has(combo)) return combo;
    }
  }

  // Nuclear fallback (should never happen with 210+ combos)
  return `agent-${Math.random().toString(36).slice(2, 8)}`;
}
