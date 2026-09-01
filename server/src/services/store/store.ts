import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, DB_PATH, EXPORTS_DIR, FILES_DIR } from "../../config.js";
import type {
  Annotation,
  ExtractedDocument,
  GradingRecord,
  StoredDocument,
} from "../../domain/types.js";

/**
 * Persistence.
 *
 * A single JSON index plus one file per uploaded PDF and per extraction. A real
 * deployment would use SQLite or Postgres; for a local marking tool this keeps the
 * data inspectable by hand, adds no native dependency, and is trivially resettable -
 * which matters more here than throughput. Writes are serialised through a promise
 * chain and land via write-then-rename so an interrupted write cannot corrupt the index.
 */

interface Db {
  version: 1;
  documents: StoredDocument[];
  gradings: GradingRecord[];
}

const EMPTY: Db = { version: 1, documents: [], gradings: [] };

let cache: Db | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

async function ensureDirs(): Promise<void> {
  await fs.mkdir(FILES_DIR, { recursive: true });
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function load(): Promise<Db> {
  if (cache) return cache;
  await ensureDirs();
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as Db;
    cache = { ...EMPTY, ...parsed };
  } catch {
    // Missing or unreadable index: start clean rather than refusing to boot. The
    // uploaded files themselves are still on disk if a recovery is ever needed.
    cache = structuredClone(EMPTY);
  }
  return cache;
}

/** Serialise every mutation, and never leave a half-written index behind. */
function commit(): Promise<void> {
  writeChain = writeChain.then(async () => {
    const db = cache ?? EMPTY;
    const tmp = `${DB_PATH}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await fs.rename(tmp, DB_PATH);
  });
  return writeChain as Promise<void>;
}

/** Test hook: forget the in-memory index so a fresh data dir is picked up. */
export function resetStoreCache(): void {
  cache = null;
}

/* ------------------------------------------------------------------ documents */

export async function saveDocument(args: {
  kind: StoredDocument["kind"];
  filename: string;
  mimeType: string;
  bytes: Buffer;
  extraction: ExtractedDocument;
}): Promise<StoredDocument> {
  const db = await load();
  const id = randomUUID();
  const fileName = `${id}.pdf`;
  const extractionName = `${id}.extract.json`;

  await fs.writeFile(path.join(FILES_DIR, fileName), args.bytes);
  await fs.writeFile(
    path.join(FILES_DIR, extractionName),
    JSON.stringify(args.extraction),
    "utf8",
  );

  const doc: StoredDocument = {
    id,
    kind: args.kind,
    filename: args.filename,
    mimeType: args.mimeType,
    bytes: args.bytes.length,
    storedAt: new Date().toISOString(),
    pageCount: args.extraction.pages.length,
    charCount: args.extraction.charCount,
    isBlank: args.extraction.isBlank,
    extractionFile: extractionName,
    file: fileName,
  };

  db.documents.unshift(doc);
  await commit();
  return doc;
}

export async function listDocuments(): Promise<StoredDocument[]> {
  return (await load()).documents;
}

export async function getDocument(id: string): Promise<StoredDocument | undefined> {
  return (await load()).documents.find((d) => d.id === id);
}

export async function readDocumentBytes(doc: StoredDocument): Promise<Buffer> {
  return fs.readFile(path.join(FILES_DIR, doc.file));
}

export async function readExtraction(doc: StoredDocument): Promise<ExtractedDocument> {
  const raw = await fs.readFile(path.join(FILES_DIR, doc.extractionFile), "utf8");
  return JSON.parse(raw) as ExtractedDocument;
}

/* ------------------------------------------------------------------- gradings */

export async function saveGrading(record: GradingRecord): Promise<GradingRecord> {
  const db = await load();
  db.gradings.unshift(record);
  await commit();
  return record;
}

export async function listGradings(): Promise<GradingRecord[]> {
  return (await load()).gradings;
}

export async function getGrading(id: string): Promise<GradingRecord | undefined> {
  return (await load()).gradings.find((g) => g.result.id === id);
}

export async function deleteGrading(id: string): Promise<boolean> {
  const db = await load();
  const before = db.gradings.length;
  db.gradings = db.gradings.filter((g) => g.result.id !== id);
  if (db.gradings.length === before) return false;
  await commit();
  return true;
}

/**
 * Replace a grading's annotation layer.
 *
 * Annotations are stored beside the grade rather than inside it precisely so this
 * can happen: editing, moving or deleting a box never touches the marks and never
 * re-runs the grader.
 */
export async function updateAnnotations(
  gradingId: string,
  mutate: (current: Annotation[]) => Annotation[],
): Promise<Annotation[] | undefined> {
  const db = await load();
  const record = db.gradings.find((g) => g.result.id === gradingId);
  if (!record) return undefined;
  record.annotations = mutate(record.annotations);
  await commit();
  return record.annotations;
}
