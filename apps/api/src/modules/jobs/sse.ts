/** Encode persisted events only. Payload JSON cannot inject SSE framing. */
export function encodeSse(id: string, type: string, payload: unknown): string {
  if (!/^[0-9]+$/.test(id) || !/^[a-zA-Z0-9_.-]+$/.test(type)) {
    throw new Error("Invalid persisted event framing");
  }
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function parseCursor(value: unknown): string {
  if (value === undefined || value === null || value === "") return "0";
  if (typeof value !== "string" || !/^[0-9]{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw Object.assign(new Error("Event cursor must be a nonnegative int64"), { statusCode: 400 });
  }
  return BigInt(value).toString();
}
