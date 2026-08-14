import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export const maximumEvidenceBytes = 10 * 1024 * 1024;

export async function writeImmutableJsonEvidence(filename, value) {
  const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (serialized.byteLength > maximumEvidenceBytes) {
    throw new RangeError("evidence JSON exceeds 10 MiB");
  }

  const digest = createHash("sha256").update(serialized).digest("hex");
  const directory = path.dirname(filename);
  const basename = path.basename(filename);
  const nonce = randomUUID();
  const dataTemporary = path.join(directory, `.${basename}.${nonce}.tmp`);
  const digestFilename = `${filename}.sha256`;
  const digestTemporary = path.join(directory, `.${basename}.${nonce}.sha256.tmp`);
  try {
    await writeDurableFile(dataTemporary, serialized);
    await writeDurableFile(digestTemporary, Buffer.from(`${digest}  ${basename}\n`, "utf8"));
    await link(dataTemporary, filename);
    try {
      await link(digestTemporary, digestFilename);
    } catch (error) {
      await unlink(filename);
      throw error;
    }
    await syncDirectory(directory);
  } finally {
    await removeTemporary(dataTemporary);
    await removeTemporary(digestTemporary);
  }

  return { bytes: serialized.byteLength, digest, digestFilename, filename };
}

export async function verifyEvidenceDigest(filename) {
  const digestFilename = `${filename}.sha256`;
  const [dataMetadata, digestMetadata] = await Promise.all([
    regularFileMetadata(filename, "evidence file"),
    regularFileMetadata(digestFilename, "evidence digest"),
  ]);
  if (dataMetadata.size === 0) throw new Error("evidence file is empty");
  if (dataMetadata.size > maximumEvidenceBytes) throw new Error("evidence file exceeds 10 MiB");
  if (digestMetadata.size > 256) throw new Error("evidence digest exceeds 256 bytes");

  const [data, digestText] = await Promise.all([
    readFile(filename),
    readFile(digestFilename, "utf8"),
  ]);
  const expectedLine = /^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)\n$/u.exec(digestText);
  if (expectedLine === null) throw new Error("evidence digest has an invalid format");
  if (expectedLine[2] !== path.basename(filename)) {
    throw new Error("evidence digest names a different file");
  }
  const actualDigest = createHash("sha256").update(data).digest("hex");
  if (actualDigest !== expectedLine[1]) throw new Error("evidence SHA-256 does not match");
  return { bytes: data.byteLength, digest: actualDigest };
}

async function writeDurableFile(filename, bytes) {
  const handle = await open(filename, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function regularFileMetadata(filename, label) {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`${label} is missing`, { cause: error });
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  return metadata;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32" &&
      error !== null &&
      typeof error === "object" &&
      ["EINVAL", "ENOTSUP", "EPERM"].includes(error.code)
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function removeTemporary(filename) {
  try {
    await unlink(filename);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
}
