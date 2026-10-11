export function redact(text: string, _names: unknown[]): string {
  return text.replace(/\d[\d\s.,()-]{6,}\d/g, "[PHONE]");
}
