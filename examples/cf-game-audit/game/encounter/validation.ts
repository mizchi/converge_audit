/** Shared shape checks; no transport or inventory dependency. */
export const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
