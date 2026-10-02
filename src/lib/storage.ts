// localStorage helpers. All reads/writes are guarded: storage can be unavailable
// (private mode, blocked site data) or full, and the app must still work.

const PREFIX = "hivemind.v1.";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Returns false if the value could not be saved (quota exceeded or storage blocked). */
export function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
