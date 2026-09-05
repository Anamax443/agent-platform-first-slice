// JSON Canonicalization Scheme (RFC 8785) for the data shapes used by the contracts:
// objects with keys sorted by UTF-16 code units, arrays in order, no whitespace,
// ES6 number and string serialization (JSON.stringify), undefined members omitted.

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((x) => canonicalize(x === undefined ? null : x)).join(",") + "]";
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}
