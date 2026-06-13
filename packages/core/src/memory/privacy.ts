import type { Sensitivity } from "../knowledge/schema-doc.js";

/**
 * Patterns for high-confidence secrets — credentials that must never be written
 * into a wiki page or kept verbatim in memory. Deliberately conservative: these
 * match well-known token shapes, not arbitrary "looks secret" text, so normal
 * prose is not mangled.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style secret keys
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/gi, // key: value secrets
];

export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Personal data that is sensitive but not a credential — it stays in memory
 * (unredacted, the user may want to recall it) but is kept *out* of the
 * portable, git-synced wiki by being classed "private".
 */
const PII_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email
  /(?<!\d)(?:\+?\d[\s().-]?){9,}\d(?!\d)/, // phone-ish run of digits
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN
  /\b(?:\d[ -]?){13,16}\b/, // card-number-ish
];

/** True when the text contains a recognised credential. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/** True when the text contains recognised personal data (email, phone, SSN, card). */
export function containsPII(text: string): boolean {
  return PII_PATTERNS.some((pattern) => pattern.test(text));
}

/** Replace recognised credentials with a placeholder, leaving prose intact. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // For "key: value" matches, keep the label and redact only the value.
      const labelled = match.match(/^([\w-]+\s*[:=]\s*)/);
      return labelled ? `${labelled[1]}${REDACTION_PLACEHOLDER}` : REDACTION_PLACEHOLDER;
    });
  }
  return out;
}

/**
 * Detection-side sensitivity: "secret" for a credential, "private" for personal
 * data (PII), else "normal". The extractor may independently label a claim; the
 * stored sensitivity is the stronger of the two (see strongerSensitivity).
 */
export function detectSensitivity(text: string): Sensitivity {
  if (containsSecret(text)) return "secret";
  if (containsPII(text)) return "private";
  return "normal";
}
