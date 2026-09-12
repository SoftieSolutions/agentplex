/**
 * A stand-in for a localStorage that behaves: a map behind the `Storage`
 * interface. The browsers that do not behave are stood in for at the token
 * store's access seam, not here -- a throwing accessor is where a real
 * privacy-mode browser throws.
 */
export function fakeStorage(initial: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(initial));
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  };
}
