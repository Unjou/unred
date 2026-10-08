import type { ScriptDocument } from "./kag";

const DATABASE_NAME = "vnloc-studio";
const STORE_NAME = "documents";
const FALLBACK_KEY = "vnloc-studio:documents";
const DATABASE_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local storage"));
    request.onblocked = () => reject(new Error("Local storage upgrade is blocked by another open tab"));
  });
}

function fallbackRead(): ScriptDocument[] {
  const raw = localStorage.getItem(FALLBACK_KEY);
  if (!raw) return [];
  const documents: unknown = JSON.parse(raw);
  if (!Array.isArray(documents)) throw new Error("Saved local project data is invalid");
  return documents as ScriptDocument[];
}

function fallbackWrite(documents: ScriptDocument[]): void {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(documents));
}

export async function loadDocuments(): Promise<ScriptDocument[]> {
  try {
    const database = await openDatabase();
    const documents = await new Promise<ScriptDocument[]>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as ScriptDocument[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read saved projects"));
    });
    database.close();
    return documents.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    try {
      return fallbackRead().sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (fallbackError) {
      throw new Error("Could not load saved projects from this browser", { cause: fallbackError ?? error });
    }
  }
}

export async function saveDocument(document: ScriptDocument): Promise<void> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(document);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save project"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Project save was cancelled"));
    });
    database.close();
  } catch (error) {
    try {
      const documents = fallbackRead();
      const index = documents.findIndex((item) => item.id === document.id);
      if (index === -1) documents.push(document);
      else documents[index] = document;
      fallbackWrite(documents);
    } catch (fallbackError) {
      throw new Error("Could not save this project in the browser", { cause: fallbackError ?? error });
    }
  }
}

export async function deleteDocument(id: string): Promise<void> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove project"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Project removal was cancelled"));
    });
    database.close();
  } catch (error) {
    try {
      fallbackWrite(fallbackRead().filter((document) => document.id !== id));
    } catch (fallbackError) {
      throw new Error("Could not remove this project from the browser", { cause: fallbackError ?? error });
    }
  }
}
