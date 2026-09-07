/** Public errors and diagnostics contain no upstream payloads or exception text. */
const categories: Record<number, [string, string, string]> = {
  400: ["invalid_request_error", "invalid_request", "Invalid request. Check the supported fields and message history."],
  401: ["authentication_error", "authentication_required", "Supply a configured Mirror API key and check session readiness."],
  403: ["permission_error", "request_forbidden", "Request rejected. Check the browser origin and account permissions."],
  404: ["invalid_request_error", "not_found", "The requested resource was not found."],
  409: ["invalid_request_error", "conversation_conflict", "Conversation or session changed. Reload before continuing."],
  429: ["rate_limit_error", "rate_limit_exceeded", "Rate limit reached. Wait before sending another request."],
  504: ["timeout_error", "deadline_exceeded", "Generation deadline exceeded. Reload history before retrying; upstream completion is uncertain."],
};
const recent: Array<{ at: string; code: string; requestId: string }> = [];
export function apiError(status: number, message: string, requestId: string) {
  const [type, code, fallback] = categories[status] ?? ["server_error", "upstream_failure", "Generation failed. Check WARP and session readiness, then reload history before retrying."];
  return { error: { type, code, message: status === 400 ? message : fallback, request_id: requestId } };
}
export function recordFailure(code: string, requestId: string) {
  recent.push({ at: new Date().toISOString(), code, requestId });
  if (recent.length > 20) recent.shift();
}
export function recentFailures() { return recent.map(item => ({ ...item })); }
