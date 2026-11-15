/**
 * Validate a post-sign-in return path. Only same-site absolute paths are
 * accepted — protocol-relative URLs, backslashes, and oversized values
 * fall back to the dashboard, so a `next` parameter can never become an
 * open redirect.
 */
export function validateNextPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (raw.length === 0 || raw.length > 1024) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw;
}
