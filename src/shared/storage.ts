/** chrome.storage and IndexedDB helpers (PLAN §2 session persistence, §6 language defaults). */
import type { ModelInfo, RecorderState, Segment, SessionMeta, Settings } from './types';
import { DEFAULT_STATE } from './types';

// ---- Settings (chrome.storage.sync) ----------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = {
  defaultLanguage: 'auto',
  quantPreset: 'balanced',
  filenameTemplate: 'Meet - {meetingTitle} - {YYYY-MM-DD HHmm}.md',
  timestampStyle: 'hms',
  recentLanguages: [],
  favoriteLanguages: [],
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...((stored.settings as Partial<Settings>) ?? {}) };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

/** Moves a language to the front of the recent list (max 5). */
export async function pushRecentLanguage(code: string): Promise<void> {
  if (code === 'auto') return;
  const s = await getSettings();
  const recents = [code, ...s.recentLanguages.filter((c) => c !== code)].slice(0, 5);
  await updateSettings({ recentLanguages: recents });
}

// ---- Model info (chrome.storage.local) -------------------------------------------------------

export async function getModelInfo(): Promise<ModelInfo | undefined> {
  const stored = await chrome.storage.local.get('modelInfo');
  return stored.modelInfo as ModelInfo | undefined;
}

export async function setModelInfo(info: ModelInfo | undefined): Promise<void> {
  if (info) await chrome.storage.local.set({ modelInfo: info });
  else await chrome.storage.local.remove('modelInfo');
}

// ---- Recorder state (chrome.storage.session, survives SW restarts) ---------------------------

export async function loadRecorderState(): Promise<RecorderState> {
  const stored = await chrome.storage.session.get('recorderState');
  return { ...DEFAULT_STATE, ...((stored.recorderState as RecorderState) ?? {}) };
}

export async function saveRecorderState(state: RecorderState): Promise<void> {
  await chrome.storage.session.set({ recorderState: state });
}

// ---- IndexedDB: sessions + segments ----------------------------------------------------------

const DB_NAME = 'meet-transcript-notes';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const SEGMENTS = 'segments';

let dbPromise: Promise<IDBDatabase> | undefined;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSIONS)) {
        db.createObjectStore(SESSIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SEGMENTS)) {
        const store = db.createObjectStore(SEGMENTS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putSession(session: SessionMeta): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SESSIONS, 'readwrite');
  tx.objectStore(SESSIONS).put(session);
  await txDone(tx);
}

export async function getSession(id: string): Promise<SessionMeta | undefined> {
  const db = await openDb();
  return promisify(db.transaction(SESSIONS).objectStore(SESSIONS).get(id));
}

export async function updateSession(
  id: string,
  patch: Partial<SessionMeta>,
): Promise<SessionMeta | undefined> {
  const current = await getSession(id);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  await putSession(next);
  return next;
}

export async function listSessions(): Promise<SessionMeta[]> {
  const db = await openDb();
  return promisify(db.transaction(SESSIONS).objectStore(SESSIONS).getAll());
}

export async function addSegments(segments: Segment[]): Promise<Segment[]> {
  if (segments.length === 0) return [];
  const db = await openDb();
  const tx = db.transaction(SEGMENTS, 'readwrite');
  const store = tx.objectStore(SEGMENTS);
  const saved: Segment[] = [];
  for (const seg of segments) {
    const { id: _ignored, ...rest } = seg;
    const req = store.add(rest);
    req.onsuccess = () => saved.push({ ...rest, id: req.result as number });
  }
  await txDone(tx);
  return saved;
}

export async function getSegments(sessionId: string): Promise<Segment[]> {
  const db = await openDb();
  const index = db.transaction(SEGMENTS).objectStore(SEGMENTS).index('sessionId');
  const segs = await promisify(index.getAll(IDBKeyRange.only(sessionId)));
  return (segs as Segment[]).sort((a, b) => a.start - b.start || (a.id ?? 0) - (b.id ?? 0));
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSIONS, SEGMENTS], 'readwrite');
  tx.objectStore(SESSIONS).delete(sessionId);
  const index = tx.objectStore(SEGMENTS).index('sessionId');
  const req = index.openKeyCursor(IDBKeyRange.only(sessionId));
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      tx.objectStore(SEGMENTS).delete(cursor.primaryKey);
      cursor.continue();
    }
  };
  await txDone(tx);
}

/** Deletes saved sessions older than `maxAgeMs` so IndexedDB doesn't grow forever. */
export async function pruneSavedSessions(maxAgeMs: number): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  for (const s of await listSessions()) {
    if (s.status === 'saved' && (s.endedAt ?? s.startedAt) < cutoff) {
      await deleteSession(s.id);
    }
  }
}

