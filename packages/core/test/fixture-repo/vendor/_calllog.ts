export const calls: { vendor: string; method: string; payload: unknown; ts: number }[] = [];
export function logCall(vendor: string, method: string, payload: unknown) {
  calls.push({ vendor, method, payload, ts: calls.length });
}
