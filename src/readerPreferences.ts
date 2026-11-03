export function preference(key: string, fallback: string): string {
  try { return localStorage.getItem('copycopy-reader-' + key) || fallback } catch { return fallback }
}
export function savePreference(key: string, value: string) {
  try { localStorage.setItem('copycopy-reader-' + key, value) } catch { /* Session preferences remain usable. */ }
}
