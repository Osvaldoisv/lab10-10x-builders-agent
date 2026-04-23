/**
 * Appends temporal context (timezone + current local datetime) to the base system prompt.
 * This allows the agent to interpret relative times ("tomorrow at 9 AM") correctly
 * and to populate timezone fields in scheduled tasks without asking the user.
 */
export function buildSystemPrompt(basePrompt: string, timezone: string): string {
  const now = new Date();
  const localDatetime = now.toLocaleString("es", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `${basePrompt}\n\nZona horaria del usuario: ${timezone}\nFecha y hora actual: ${localDatetime}`;
}
