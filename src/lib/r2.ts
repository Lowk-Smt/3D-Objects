/**
 * Cloudflare R2 object storage abstraction.
 *
 * This is the ONLY module that talks to R2 (via the AWS S3-compatible API).
 * Everything above it (src/lib/storage.ts, the API routes) works in terms of
 * file ids + sanitized names and never touches credentials, endpoints or
 * buckets directly — and nothing here is ever imported by browser code, so R2
 * credentials cannot leak to the client.
 *
 * Design notes:
 *
 *  - The bucket stays PRIVATE. Reads/writes go through the authenticated
 *    Next.js API (which streams bytes after checking the session), and large
 *    browser uploads use short-lived presigned PUT URLs minted per object key.
 *  - Object keys are server-generated, never client-supplied:
 *      files/<id>/<sanitized-name>      model binaries
 *      thumbnails/<id>.<ext>            thumbnails
 *    `fileObjectKey()` strictly validates both parts and rejects anything
 *    that did not come out of the sanitizers in src/lib/files.ts, so a
 *    hostile filename can never become an arbitrary key.
 *  - This module has NO imports from `@/...` (only node builtins, the AWS SDK
 *    and type-only imports), so the unit tests can exercise the real key
 *    generation, error mapping and multi-step object sequences without a
 *    database, without Next.js and without network access (see
 *    tests/r2-storage.test.mjs, which runs them against MemoryObjectStore).
 */

import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/* ------------------------------------------------------------------ errors */

export class R2Error extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "R2Error";
    this.status = status;
  }
}

/* ------------------------------------------------------------------- config */

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
};

export const PRESIGNED_PUT_EXPIRES_IN_SECONDS = 5 * 60;
export const PRESIGNED_GET_EXPIRES_IN_SECONDS = 5 * 60;

function readEnv(name: string): string {
  return (process.env[name] || "").trim();
}

/** Null when any required variable is missing — callers decide how to fail. */
export function r2ConfigFromEnv(): R2Config | null {
  const accountId = readEnv("R2_ACCOUNT_ID");
  const accessKeyId = readEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = readEnv("R2_SECRET_ACCESS_KEY");
  const bucket = readEnv("R2_BUCKET_NAME");
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;

  const endpoint = readEnv("R2_ENDPOINT") || `https://${accountId}.r2.cloudflarestorage.com`;
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint };
}

export function isR2Configured(): boolean {
  return r2ConfigFromEnv() !== null;
}

/**
 * Throws R2Error(503) with an operator-actionable (but credential-free)
 * message when R2 is not configured. Called at request time, never at import
 * time, so `next build` and the unit tests work without credentials.
 */
export function requireR2Config(): R2Config {
  const config = r2ConfigFromEnv();
  if (!config) {
    throw new R2Error(
      503,
      "Object storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, " +
        "R2_SECRET_ACCESS_KEY and R2_BUCKET_NAME (see .env.example).",
    );
  }
  return config;
}

/* --------------------------------------------------------------------- keys */

/**
 * File ids are server-generated (UUIDs). The pattern mirrors isSafeFileId() in
 * src/lib/files.ts; both are pinned by tests so they cannot silently diverge.
 */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A stored name that already went through sanitizeStoredName(): no slashes
 * (so it is always exactly one key segment), no control characters, no
 * leading dot (never a hidden file), bounded length. R2 keys are opaque
 * strings rather than filesystem paths, so there is no traversal to begin
 * with — this strictness is defense in depth plus a guarantee that only
 * sanitized names ever become keys.
 */
const STORED_NAME_PATTERN = /^[^\x00-\x1f\x7f/\\]{1,180}$/;

export function assertSafeFileId(id: string): string {
  if (typeof id !== "string" || !FILE_ID_PATTERN.test(id)) {
    throw new R2Error(400, "Invalid file id.");
  }
  return id;
}

export function assertSafeStoredName(storedName: string): string {
  if (
    typeof storedName !== "string" ||
    !STORED_NAME_PATTERN.test(storedName) ||
    storedName === "." ||
    storedName === ".." ||
    storedName.startsWith(".") ||
    storedName.trim() !== storedName
  ) {
    throw new R2Error(400, "Invalid object name.");
  }
  return storedName;
}

const THUMBNAIL_EXTS = ["jpg", "png", "webp", "gif"] as const;
export type ThumbnailExt = (typeof THUMBNAIL_EXTS)[number];

export function normalizeThumbnailExt(ext: string | null | undefined): ThumbnailExt {
  const lower = String(ext || "").toLowerCase();
  return (THUMBNAIL_EXTS as readonly string[]).includes(lower) ? (lower as ThumbnailExt) : "jpg";
}

/** `files/<id>/<sanitized-name>` — the single home of a model's bytes. */
export function fileObjectKey(id: string, storedName: string): string {
  return `files/${assertSafeFileId(id)}/${assertSafeStoredName(storedName)}`;
}

/** `thumbnails/<id>.<ext>` — one thumbnail per file, typed by its bytes. */
export function thumbnailObjectKey(id: string, ext: string): string {
  return `thumbnails/${assertSafeFileId(id)}.${normalizeThumbnailExt(ext)}`;
}

/**
 * Every key a thumbnail for `id` could live under (hint first, then every
 * supported extension), used for reads, repairs and deletes.
 */
export function thumbnailCandidateKeys(id: string, hintExt?: string | null): string[] {
  assertSafeFileId(id);
  const exts = [normalizeThumbnailExt(hintExt), ...THUMBNAIL_EXTS].filter(
    (ext, index, all) => all.indexOf(ext) === index,
  );
  return exts.map((ext) => `thumbnails/${id}.${ext}`);
}

/** Every R2 key owned by one library file (model bytes + thumbnail variants). */
export function fileObjectKeysForDelete(id: string, storedName: string, thumbExt?: string | null): string[] {
  return [fileObjectKey(id, storedName), ...thumbnailCandidateKeys(id, thumbExt)];
}

/* -------------------------------------------------------------------- store */

export type ObjectHead = {
  size: number;
  contentType?: string;
  lastModified?: Date;
};

export type ObjectData = {
  data: Buffer;
  contentType?: string;
};

export type ObjectStream = {
  stream: ReadableStream<Uint8Array>;
  size: number;
  contentType?: string;
};

export type ObjectListing = {
  key: string;
  size: number;
  lastModified?: Date;
};

/**
 * Minimal object-store surface used by the app. R2Store implements it against
 * Cloudflare R2; MemoryObjectStore implements it in memory for unit tests.
 */
export interface ObjectStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Null when the key does not exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** Null when the key does not exist. */
  getBuffer(key: string): Promise<ObjectData | null>;
  /** Null when the key does not exist. */
  getStream(key: string): Promise<ObjectStream | null>;
  /** Deleting a missing key succeeds (S3 deletes are idempotent). */
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<{ deleted: string[]; failed: string[] }>;
  copy(fromKey: string, toKey: string, contentType: string): Promise<void>;
  list(prefix: string, limit: number): Promise<ObjectListing[]>;
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  presignGet(
    key: string,
    opts: {
      contentType?: string;
      disposition?: "inline" | "attachment";
      filename?: string;
      expiresInSeconds: number;
    },
  ): Promise<string>;
}

/** RFC 5987-safe Content-Disposition for presigned GET responses. */
export function presignedDisposition(disposition: "inline" | "attachment", filename: string): string {
  const cleaned = String(filename || "download").replace(/[\r\n]/g, " ").trim() || "download";
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "'");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (record.name === "NoSuchKey" || record.name === "NotFound") return true;
  if (record.Code === "NoSuchKey" || record.Code === "NotFound") return true;
  return record.$metadata?.httpStatusCode === 404;
}

/**
 * Maps an SDK failure to an R2Error. The full detail is logged server-side;
 * the client-facing message stays generic so SDK internals (endpoints,
 * request ids, key names) can never leak to the browser.
 */
export function toR2Error(err: unknown, what: string): R2Error {
  if (err instanceof R2Error) return err;
  console.error(`[r2] ${what} failed:`, err);
  return new R2Error(502, `Object storage is temporarily unavailable (${what}). Please try again in a moment.`);
}

export class R2Store implements ObjectStore {
  private client: S3Client | null = null;
  private bucket: string | null = null;

  private connection(): { client: S3Client; bucket: string } {
    if (this.client && this.bucket) return { client: this.client, bucket: this.bucket };
    const config = requireR2Config();
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // R2 only requires checksums when an operation mandates them; the SDK's
      // default "compute when supported" breaks against some S3-compatible
      // endpoints, so opt into checksums only when required.
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
    return { client: this.client, bucket: this.bucket };
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const { client, bucket } = this.connection();
    try {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: contentType }),
      );
    } catch (err) {
      throw toR2Error(err, "upload");
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    const { client, bucket } = this.connection();
    try {
      const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        size: Number(out.ContentLength || 0),
        contentType: out.ContentType,
        lastModified: out.LastModified,
      };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw toR2Error(err, "metadata lookup");
    }
  }

  async getBuffer(key: string): Promise<ObjectData | null> {
    const { client, bucket } = this.connection();
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = out.Body as unknown;
      const data = await collectBody(body);
      return { data, contentType: out.ContentType };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw toR2Error(err, "download");
    }
  }

  async getStream(key: string): Promise<ObjectStream | null> {
    const { client, bucket } = this.connection();
    let out;
    try {
      out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw toR2Error(err, "download");
    }
    try {
      const body = out.Body as unknown;
      const stream = toWebStream(body);
      return {
        stream,
        size: Number(out.ContentLength || 0),
        contentType: out.ContentType,
      };
    } catch (err) {
      throw toR2Error(err, "download");
    }
  }

  async delete(key: string): Promise<void> {
    const { client, bucket } = this.connection();
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      throw toR2Error(err, "delete");
    }
  }

  async deleteMany(keys: string[]): Promise<{ deleted: string[]; failed: string[] }> {
    const { client, bucket } = this.connection();
    const deleted: string[] = [];
    const failed: string[] = [];
    // S3 multi-delete takes at most 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      try {
        const out = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        const errored = new Set((out.Errors || []).map((e) => e.Key));
        for (const key of chunk) {
          if (errored.has(key)) failed.push(key);
          else deleted.push(key);
        }
      } catch (err) {
        console.error("[r2] Multi-delete failed, retrying keys one by one:", err);
        for (const key of chunk) {
          try {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
            deleted.push(key);
          } catch (singleErr) {
            console.error(`[r2] Could not delete ${key}:`, singleErr);
            failed.push(key);
          }
        }
      }
    }
    return { deleted, failed };
  }

  async copy(fromKey: string, toKey: string, contentType: string): Promise<void> {
    const { client, bucket } = this.connection();
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: toKey,
          CopySource: `/${bucket}/${fromKey.split("/").map(encodeURIComponent).join("/")}`,
          ContentType: contentType,
          MetadataDirective: "REPLACE",
        }),
      );
    } catch (err) {
      throw toR2Error(err, "copy");
    }
  }

  async list(prefix: string, limit: number): Promise<ObjectListing[]> {
    const { client, bucket } = this.connection();
    const out: ObjectListing[] = [];
    let token: string | undefined;
    try {
      for (;;) {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: Math.min(1000, Math.max(1, limit - out.length)),
          }),
        );
        for (const obj of page.Contents || []) {
          if (!obj.Key) continue;
          out.push({ key: obj.Key, size: Number(obj.Size || 0), lastModified: obj.LastModified });
          if (out.length >= limit) return out;
        }
        if (!page.IsTruncated) return out;
        token = page.NextContinuationToken;
        if (!token) return out;
      }
    } catch (err) {
      throw toR2Error(err, "listing");
    }
  }

  async presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    const { client, bucket } = this.connection();
    try {
      // The browser must send this exact Content-Type on the PUT; it is part
      // of the signature, so the stored object's type cannot be smuggled.
      const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
      return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    } catch (err) {
      throw toR2Error(err, "presigned upload");
    }
  }

  async presignGet(
    key: string,
    opts: {
      contentType?: string;
      disposition?: "inline" | "attachment";
      filename?: string;
      expiresInSeconds: number;
    },
  ): Promise<string> {
    const { client, bucket } = this.connection();
    try {
      // Minted only after the API authorized the request; the response
      // overrides make the download behave like the streamed one (correct
      // MIME + filename) even though R2 serves the bytes.
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition:
          opts.disposition && opts.filename
            ? presignedDisposition(opts.disposition, opts.filename)
            : undefined,
      });
      return await getSignedUrl(client, command, { expiresIn: opts.expiresInSeconds });
    } catch (err) {
      throw toR2Error(err, "presigned download");
    }
  }
}

async function collectBody(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof (body as { transformToByteArray?: unknown })?.transformToByteArray === "function") {
    return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
  }
  const chunks: Buffer[] = [];
  const stream = body as AsyncIterable<Buffer | Uint8Array | string>;
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Unsupported S3 response body type.");
}

function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return body as ReadableStream<Uint8Array>;
  }
  if (body instanceof Readable) {
    return Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>;
  }
  if (body instanceof Uint8Array) {
    const copy = body;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(copy);
        controller.close();
      },
    });
  }
  throw new Error("Unsupported S3 response body type.");
}

/* ------------------------------------------------------- process singleton */

let testOverride: ObjectStore | null = null;
let shared: R2Store | null = null;

/** The process-wide store. Real R2 in production, injectable in tests. */
export function getObjectStore(): ObjectStore {
  if (testOverride) return testOverride;
  if (!shared) shared = new R2Store();
  return shared;
}

/** Unit tests (and only unit tests) use this to inject MemoryObjectStore. */
export function __setObjectStoreForTests(store: ObjectStore | null): void {
  testOverride = store;
}

/* ------------------------------------------------- in-memory fake for tests */

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { data: Buffer; contentType: string; lastModified: Date }>();
  /** When set, `put` throws this instead of storing (fault injection). */
  failPutWith: unknown = null;
  /** When set, `head` reports this size instead of the real one. */
  lieAboutSize: number | null = null;
  /** When set, `delete`/`deleteMany` throws this (fault injection). */
  failDeleteWith: unknown = null;

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    if (this.failPutWith) throw this.failPutWith;
    this.objects.set(key, { data: Buffer.from(data), contentType, lastModified: new Date() });
  }

  async head(key: string): Promise<ObjectHead | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    return {
      size: this.lieAboutSize ?? found.data.length,
      contentType: found.contentType,
      lastModified: found.lastModified,
    };
  }

  async getBuffer(key: string): Promise<ObjectData | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    return { data: Buffer.from(found.data), contentType: found.contentType };
  }

  async getStream(key: string): Promise<ObjectStream | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    const data = found.data;
    return {
      size: data.length,
      contentType: found.contentType,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(data));
          controller.close();
        },
      }),
    };
  }

  async delete(key: string): Promise<void> {
    if (this.failDeleteWith) throw this.failDeleteWith;
    this.objects.delete(key);
  }

  async deleteMany(keys: string[]): Promise<{ deleted: string[]; failed: string[] }> {
    if (this.failDeleteWith) return { deleted: [], failed: [...keys] };
    for (const key of keys) this.objects.delete(key);
    return { deleted: [...keys], failed: [] };
  }

  async copy(fromKey: string, toKey: string, contentType: string): Promise<void> {
    const found = this.objects.get(fromKey);
    if (!found) throw new R2Error(404, "Source object not found.");
    this.objects.set(toKey, { data: Buffer.from(found.data), contentType, lastModified: new Date() });
  }

  async list(prefix: string, limit: number): Promise<ObjectListing[]> {
    const out: ObjectListing[] = [];
    for (const [key, value] of this.objects) {
      if (!key.startsWith(prefix)) continue;
      out.push({ key, size: value.data.length, lastModified: value.lastModified });
      if (out.length >= limit) break;
    }
    return out;
  }

  async presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    void contentType;
    return `https://r2.test-presigned/put/${encodeURIComponent(key)}?expiresIn=${expiresInSeconds}`;
  }

  async presignGet(
    key: string,
    opts: {
      contentType?: string;
      disposition?: "inline" | "attachment";
      filename?: string;
      expiresInSeconds: number;
    },
  ): Promise<string> {
    const params = new URLSearchParams({ expiresIn: String(opts.expiresInSeconds) });
    if (opts.contentType) params.set("response-content-type", opts.contentType);
    if (opts.disposition && opts.filename) {
      params.set("response-content-disposition", presignedDisposition(opts.disposition, opts.filename));
    }
    return `https://r2.test-presigned/get/${encodeURIComponent(key)}?${params.toString()}`;
  }
}

/* ---------------------------------------- multi-step sequences (unit-tested) */

/**
 * Uploads bytes and verifies them with a HEAD before the caller commits
 * metadata to Postgres. If the verification fails, the just-written object is
 * deleted again (rollback) so a partial write can never linger.
 */
export async function putObjectWithVerify(
  store: ObjectStore,
  key: string,
  data: Buffer,
  contentType: string,
): Promise<{ size: number }> {
  try {
    await store.put(key, data, contentType);
  } catch (err) {
    throw err instanceof R2Error ? err : toR2Error(err, "upload");
  }

  let head: ObjectHead | null;
  try {
    head = await store.head(key);
  } catch (err) {
    await bestEffortDelete(store, key);
    throw err instanceof R2Error ? err : toR2Error(err, "upload verification");
  }

  if (!head || head.size !== data.length) {
    console.error(
      `[r2] Size mismatch after writing ${key} (stored ${head?.size}, expected ${data.length}) — rolling back.`,
    );
    await bestEffortDelete(store, key);
    throw new R2Error(502, "The file could not be written to object storage completely. Nothing was saved — please try again.");
  }

  return { size: head.size };
}

/**
 * Deletes every key owned by one library file (model bytes + all thumbnail
 * variants). Best effort per key; reports failures so the caller can mark the
 * cleanup incomplete instead of pretending it succeeded.
 */
export async function deleteFileObjects(
  store: ObjectStore,
  id: string,
  storedName: string,
  thumbExt?: string | null,
): Promise<{ deleted: string[]; failed: string[] }> {
  const keys = fileObjectKeysForDelete(id, storedName, thumbExt);
  try {
    return await store.deleteMany(keys);
  } catch (err) {
    // A store that throws for the batch (rather than reporting per-key)
    // falls back to key-by-key deletion so one bad key cannot save the rest.
    console.error("[r2] Batch delete threw, retrying key by key:", err);
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const key of keys) {
      try {
        await store.delete(key);
        deleted.push(key);
      } catch (singleErr) {
        console.error(`[r2] Could not delete ${key}:`, singleErr);
        failed.push(key);
      }
    }
    return { deleted, failed };
  }
}

/** Removes every stored thumbnail variant for `id`. Best effort per key. */
export async function deleteThumbnailObjects(
  store: ObjectStore,
  id: string,
): Promise<{ deleted: string[]; failed: string[] }> {
  try {
    return await store.deleteMany(thumbnailCandidateKeys(id, null));
  } catch (err) {
    console.error("[r2] Thumbnail batch delete threw, retrying key by key:", err);
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const key of thumbnailCandidateKeys(id, null)) {
      try {
        await store.delete(key);
        deleted.push(key);
      } catch (singleErr) {
        console.error(`[r2] Could not delete ${key}:`, singleErr);
        failed.push(key);
      }
    }
    return { deleted, failed };
  }
}

async function bestEffortDelete(store: ObjectStore, key: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (err) {
    // Loud: this is the one case that can leave orphaned bytes behind.
    console.error(`[r2] ORPHANED object ${key} — could not roll back:`, err);
  }
}
