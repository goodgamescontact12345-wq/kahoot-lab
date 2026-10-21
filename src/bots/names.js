/**
 * Bot name generation: literal lists and `{i}`/`{n}` patterns.
 */

const DEFAULT_NAMES = [
  "Quiz Bot",
  "Captain Correct",
  "Speedy Gonzalez",
  "Buford",
  "Not A Robot",
  "Test Dummy",
  "Ctrl+Alt+Defeat",
  "The Understudy",
  "Extra Player",
  "Benchwarmer",
  "Lab Rat",
  "Wildcard",
];

/**
 * Expand a name pattern.
 * ` {i}` -> 1-based index, `{n}` -> zero-padded index, `{name}` -> base name.
 * @param {string} pattern
 * @param {number} index 1-based
 * @param {number} total
 * @returns {string}
 */
export function expandPattern(pattern, index, total) {
  const pad = String(total).length;
  return pattern
    .replaceAll("{i}", String(index))
    .replaceAll("{n}", String(index).padStart(pad, "0"))
    .replaceAll("{name}", "Bot");
}

/**
 * Build the list of bot names.
 * @param {{
 *   count?:number,
 *   names?:string[],
 *   pattern?:string
 * }} opts
 * @returns {string[]}
 */
export function buildNames({ count = 1, names = null, pattern = "{name} {i}" }) {
  if (Array.isArray(names) && names.length > 0) {
    return names.map((n, i) => expandPattern(n, i + 1, names.length));
  }
  const total = Math.max(1, count);
  const out = [];
  for (let i = 1; i <= total; i++) {
    out.push(expandPattern(pattern, i, total));
  }
  return out;
}

export { DEFAULT_NAMES };
