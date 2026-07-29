/** Minimal ANSI helpers — no dependency, just the codes this CLI actually uses. */

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
} as const;

/** Wraps `text` in the named ANSI code, or returns it unchanged when `enabled` is false. */
export function paint(text: string, name: keyof typeof CODES, enabled: boolean): string {
  if (!enabled || name === "reset") return text;
  return `${CODES[name]}${text}${CODES.reset}`;
}

export function bold(text: string, enabled: boolean): string {
  return paint(text, "bold", enabled);
}

export function dim(text: string, enabled: boolean): string {
  return paint(text, "dim", enabled);
}
