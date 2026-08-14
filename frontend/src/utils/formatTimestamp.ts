// Shared timestamp formatting for chrome that surfaces sample / grade
// timestamps (ChatView footer, GradesDisplay run history).
//
// Returns a locale-friendly short datetime ("Jan 15, 2026, 10:00 AM"), or
// null when the input is empty or unparseable — callers decide the fallback
// (render the raw string, or render nothing).
export function formatTimestamp(ts: string): string | null {
  if (!ts) return null;
  const parsed = new Date(ts);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
