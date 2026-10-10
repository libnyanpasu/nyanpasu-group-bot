export function apiError(error: unknown): {
  code?: number;
  description?: string;
  parameters?: { retry_after?: number };
} {
  return error && typeof error === "object" ? error : {};
}
