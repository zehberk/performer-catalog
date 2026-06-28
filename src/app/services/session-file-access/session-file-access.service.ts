import { Injectable, signal } from '@angular/core';

export const CUSTOM_PERFORMERS_STORAGE_KEY = 'performer-catalog.custom-performers';
export const CUSTOM_STUDIOS_STORAGE_KEY = 'performer-catalog.custom-studios';
export const HIDDEN_PERFORMER_IDS_STORAGE_KEY = 'performer-catalog.hidden-performer-ids';
export const SELECTED_PERFORMER_ID_STORAGE_KEY = 'performer-catalog.selected-performer-id';
export const DEBUG_LOGS_STORAGE_KEY = 'performer-catalog.missing-lookup-debug-logs';
export const LIST_SCROLL_TOP_STORAGE_KEY = 'performer-catalog.list-scroll-top';
export const SESSION_FILE_DEBUG_LOGS_STORAGE_KEY = 'performer-catalog.session-file-debug-logs';

const trackedLocalStorageKeys = [
  CUSTOM_PERFORMERS_STORAGE_KEY,
  CUSTOM_STUDIOS_STORAGE_KEY,
  HIDDEN_PERFORMER_IDS_STORAGE_KEY,
  SESSION_FILE_DEBUG_LOGS_STORAGE_KEY,
] as const;
const trackedSessionStorageKeys = [
  SELECTED_PERFORMER_ID_STORAGE_KEY,
  DEBUG_LOGS_STORAGE_KEY,
  LIST_SCROLL_TOP_STORAGE_KEY,
] as const;
const handleDatabaseName = 'performer-catalog-session-access';
const handleStoreName = 'handles';
const handleKey = 'session-file-handle';
const maxSessionFileDebugEntries = 200;

type FileAccessState = 'unsupported' | 'not-configured' | 'prompt' | 'granted' | 'error';

interface SessionSnapshot {
  readonly savedAt: string;
  readonly origin: string;
  readonly localStorage: Readonly<Record<string, string | null>>;
  readonly sessionStorage: Readonly<Record<string, string | null>>;
}

interface FileSystemPermissionDescriptorLike {
  readonly mode?: 'read' | 'readwrite';
}

interface SaveFilePickerAcceptTypeLike {
  readonly description?: string;
  readonly accept?: Record<string, readonly string[]>;
}

interface SaveFilePickerOptionsLike {
  readonly suggestedName?: string;
  readonly types?: readonly SaveFilePickerAcceptTypeLike[];
}

interface PersistentFileSystemFileHandle extends FileSystemFileHandle {
  queryPermission(descriptor?: FileSystemPermissionDescriptorLike): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemPermissionDescriptorLike): Promise<PermissionState>;
}

interface FilePickerWindow extends Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptionsLike) => Promise<FileSystemFileHandle>;
}

@Injectable({
  providedIn: 'root',
})
export class SessionFileAccessService {
  private readonly fileHandle = signal<FileSystemFileHandle | undefined>(undefined);
  private writeChain = Promise.resolve();
  private writeScheduled = false;
  private pendingSnapshotWrite = false;

  readonly supported = signal(this.checkSupport());
  readonly hasStoredHandle = signal(false);
  readonly accessState = signal<FileAccessState>(
    this.supported() ? 'not-configured' : 'unsupported',
  );
  readonly fileName = signal<string | undefined>(undefined);
  readonly lastSavedAt = signal<string | undefined>(undefined);
  readonly busy = signal(false);

  constructor() {
    this.logDebug('Session file access service initialized.', {
      supported: this.supported(),
    });
    void this.restoreStoredHandle();
  }

  async requestAccess(): Promise<void> {
    if (!this.supported()) {
      this.logDebug('Session file access request ignored because the browser is unsupported.');
      this.accessState.set('unsupported');
      return;
    }

    const picker = this.getFilePicker();

    if (!picker) {
      this.logDebug('Session file access request ignored because no save file picker is available.');
      this.accessState.set('unsupported');
      return;
    }

    const existingHandle = this.fileHandle();

    if (existingHandle) {
      await this.requestAccessForStoredHandle(existingHandle);
      return;
    }

    this.logDebug('Requesting session file access from the browser.');
    this.busy.set(true);

    try {
      const handle = await picker({
        suggestedName: 'performer-catalog-session.json',
        types: [
          {
            description: 'JSON session snapshots',
            accept: { 'application/json': ['.json'] },
          },
        ],
      });

      const hasPermission = await this.ensureReadWritePermission(handle, true);

      if (!hasPermission) {
        this.logDebug('Session file permission was not granted after file selection.', {
          fileName: handle.name,
        });
        this.accessState.set('prompt');
        return;
      }

      this.fileHandle.set(handle);
      this.fileName.set(handle.name);
      this.accessState.set('granted');
      this.logDebug('Session file handle granted.', {
        fileName: handle.name,
      });
      await this.saveHandle(handle);
      await this.requestPersistentBrowserStorage();
      await this.writeSnapshot();
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.logDebug('Session file picker was closed before a file was selected.');
        this.accessState.set(this.fileHandle() ? 'prompt' : 'not-configured');
        return;
      }

      console.error('Unable to configure session file access.', error);
      this.logDebug('Unable to configure session file access.', {
        error: stringifyError(error),
      });
      this.accessState.set('error');
    } finally {
      this.busy.set(false);
    }
  }

  private async requestAccessForStoredHandle(handle: FileSystemFileHandle): Promise<void> {
    this.logDebug('Requesting permission for the stored session file handle.', {
      fileName: handle.name,
    });
    this.busy.set(true);

    try {
      const hasPermission = await this.ensureReadWritePermission(handle, true);

      if (!hasPermission) {
        this.logDebug('Stored session file handle permission request was denied.', {
          fileName: handle.name,
        });
        this.accessState.set('prompt');
        return;
      }

      this.fileName.set(handle.name);
      this.accessState.set('granted');
      this.logDebug('Stored session file handle permission granted.', {
        fileName: handle.name,
      });
      await this.requestPersistentBrowserStorage();
      await this.writeSnapshot();
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.logDebug('Stored session file permission prompt was dismissed.', {
          fileName: handle.name,
        });
        this.accessState.set('prompt');
        return;
      }

      console.error('Unable to restore access to the stored session file handle.', error);
      this.logDebug('Unable to restore access to the stored session file handle.', {
        fileName: handle.name,
        error: stringifyError(error),
      });
      this.accessState.set('error');
    } finally {
      this.busy.set(false);
    }
  }

  syncSessionToDisk(reason = 'sync'): void {
    if (!this.supported() || this.accessState() !== 'granted') {
      this.logDebug('Session sync skipped.', {
        reason,
        supported: this.supported(),
        accessState: this.accessState(),
      });
      return;
    }

    this.scheduleSnapshotWrite(reason);
  }

  flushSessionToDisk(reason = 'flush'): void {
    if (!this.supported() || this.accessState() !== 'granted') {
      this.logDebug('Session flush skipped.', {
        reason,
        supported: this.supported(),
        accessState: this.accessState(),
      });
      return;
    }

    this.scheduleSnapshotWrite(reason);
  }

  private checkSupport(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof indexedDB !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      this.getFilePicker() !== undefined
    );
  }

  private getFilePicker():
    | ((options?: SaveFilePickerOptionsLike) => Promise<FileSystemFileHandle>)
    | undefined {
    return (window as FilePickerWindow).showSaveFilePicker;
  }

  private async restoreStoredHandle(): Promise<void> {
    if (!this.supported()) {
      this.logDebug('Stored session file handle restore skipped because support is unavailable.');
      return;
    }

    try {
      const storedHandle = await this.readStoredHandle();

      if (!storedHandle) {
        this.logDebug('No stored session file handle was found.');
        this.hasStoredHandle.set(false);
        this.accessState.set('not-configured');
        return;
      }

      this.hasStoredHandle.set(true);
      this.fileHandle.set(storedHandle);
      this.fileName.set(storedHandle.name);

      const permissionState = await toPersistentHandle(storedHandle).queryPermission({
        mode: 'readwrite',
      });

      if (permissionState === 'granted') {
        this.accessState.set('granted');
        this.logDebug('Stored session file handle restored with granted permission.', {
          fileName: storedHandle.name,
        });
        this.syncSessionToDisk('stored handle restored');
        return;
      }

      this.logDebug('Stored session file handle restored but needs permission.', {
        fileName: storedHandle.name,
        permissionState,
      });
      this.accessState.set('prompt');
    } catch (error: unknown) {
      console.error('Unable to restore the stored session file handle.', error);
      this.logDebug('Unable to restore the stored session file handle.', {
        error: stringifyError(error),
      });
      this.hasStoredHandle.set(false);
      this.accessState.set('error');
    }
  }

  private async writeSnapshot(): Promise<void> {
    const handle = this.fileHandle();

    if (!handle) {
      this.logDebug('Snapshot write skipped because no file handle is configured.');
      return;
    }

    const hasPermission = await this.ensureReadWritePermission(handle, false);

    if (!hasPermission) {
      this.logDebug('Snapshot write skipped because permission is no longer granted.', {
        fileName: handle.name,
      });
      this.accessState.set('prompt');
      return;
    }

    this.logDebug('Writing session snapshot to disk.', {
      fileName: handle.name,
    });
    this.busy.set(true);

    try {
      const snapshot = this.captureSnapshot();
      const writable = await handle.createWritable();
      await writable.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      await writable.close();
      this.lastSavedAt.set(snapshot.savedAt);
      this.accessState.set('granted');
      this.logDebug('Session snapshot written successfully.', {
        fileName: handle.name,
        savedAt: snapshot.savedAt,
      });
    } catch (error: unknown) {
      console.error('Unable to write the session snapshot.', error);
      this.logDebug('Unable to write the session snapshot.', {
        fileName: handle.name,
        error: stringifyError(error),
      });
      this.accessState.set('error');
    } finally {
      this.busy.set(false);
    }
  }

  private captureSnapshot(): SessionSnapshot {
    return {
      savedAt: new Date().toISOString(),
      origin: window.location.origin,
      localStorage: readTrackedStorageEntries(localStorage, trackedLocalStorageKeys),
      sessionStorage: readTrackedStorageEntries(sessionStorage, trackedSessionStorageKeys),
    };
  }

  private async ensureReadWritePermission(
    handle: FileSystemFileHandle,
    request: boolean,
  ): Promise<boolean> {
    const persistentHandle = toPersistentHandle(handle);
    const permissionState = await persistentHandle.queryPermission({ mode: 'readwrite' });

    if (permissionState === 'granted') {
      return true;
    }

    if (!request) {
      this.logDebug('Read/write permission check failed without requesting new permission.', {
        fileName: handle.name,
        permissionState,
      });
      return false;
    }

    this.logDebug('Requesting read/write permission for the session file handle.', {
      fileName: handle.name,
      permissionState,
    });
    return (await persistentHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
  }

  private async requestPersistentBrowserStorage(): Promise<void> {
    if (typeof navigator.storage?.persist !== 'function') {
      return;
    }

    try {
      await navigator.storage.persist();
      this.logDebug('Persistent browser storage request completed.');
    } catch (error: unknown) {
      console.warn('Persistent browser storage could not be requested.', error);
      this.logDebug('Persistent browser storage request failed.', {
        error: stringifyError(error),
      });
    }
  }

  private async saveHandle(handle: FileSystemFileHandle): Promise<void> {
    this.logDebug('Saving session file handle to IndexedDB.', {
      fileName: handle.name,
    });
    const database = await openHandleDatabase();

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(handleStoreName, 'readwrite');
      const store = transaction.objectStore(handleStoreName);
      const request = store.put(handle, handleKey);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });

    database.close();
    this.logDebug('Session file handle saved to IndexedDB.', {
      fileName: handle.name,
    });
  }

  private async readStoredHandle(): Promise<FileSystemFileHandle | undefined> {
    const database = await openHandleDatabase();

    const handle = await new Promise<FileSystemFileHandle | undefined>((resolve, reject) => {
      const transaction = database.transaction(handleStoreName, 'readonly');
      const store = transaction.objectStore(handleStoreName);
      const request = store.get(handleKey);

      request.onsuccess = () => resolve(request.result as FileSystemFileHandle | undefined);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });

    database.close();
    return handle;
  }

  private scheduleSnapshotWrite(reason: string): void {
    this.pendingSnapshotWrite = true;
    this.logDebug('Snapshot write scheduled.', {
      reason,
      busy: this.busy(),
      writeScheduled: this.writeScheduled,
      pendingSnapshotWrite: this.pendingSnapshotWrite,
    });

    if (this.writeScheduled) {
      return;
    }

    this.writeScheduled = true;
    this.writeChain = this.writeChain
      .then(async () => {
        while (this.pendingSnapshotWrite) {
          this.pendingSnapshotWrite = false;
          this.logDebug('Processing queued snapshot write.');
          await this.writeSnapshot();
        }
      })
      .catch((error: unknown) => {
        console.error('Unable to sync session snapshot to disk.', error);
        this.logDebug('Unable to sync session snapshot to disk.', {
          error: stringifyError(error),
        });
      })
      .finally(() => {
        this.writeScheduled = false;
        this.logDebug('Snapshot write queue drained.', {
          pendingSnapshotWrite: this.pendingSnapshotWrite,
        });

        if (this.pendingSnapshotWrite) {
          this.scheduleSnapshotWrite('pending follow-up write');
        }
      });
  }

  private logDebug(message: string, details?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const entry = details ? `[${timestamp}] ${message} ${JSON.stringify(details)}` : `[${timestamp}] ${message}`;
    console.log(`[session-file-access] ${entry}`);

    try {
      const raw = localStorage.getItem(SESSION_FILE_DEBUG_LOGS_STORAGE_KEY);
      const logs = raw ? (JSON.parse(raw) as readonly unknown[]) : [];
      const normalizedLogs = logs.filter(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
      );
      const nextLogs = [...normalizedLogs, entry].slice(-maxSessionFileDebugEntries);
      localStorage.setItem(SESSION_FILE_DEBUG_LOGS_STORAGE_KEY, JSON.stringify(nextLogs));
    } catch (error: unknown) {
      console.warn('Unable to persist session file debug logs.', error);
    }
  }
}

async function openHandleDatabase(): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(handleDatabaseName, 1);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(handleStoreName)) {
        database.createObjectStore(handleStoreName);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readTrackedStorageEntries(
  storage: Storage,
  keys: readonly string[],
): Readonly<Record<string, string | null>> {
  return Object.fromEntries(keys.map((key) => [key, storage.getItem(key)]));
}

function toPersistentHandle(handle: FileSystemFileHandle): PersistentFileSystemFileHandle {
  return handle as PersistentFileSystemFileHandle;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}
