import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { MAX_FILE_BYTES } from './schema.mjs';

/** Read only bounded regular files; refuse final-component links and detect replacement races. */
export function readJsonDocument(file, maxBytes = MAX_FILE_BYTES) {
  const absolute = path.resolve(file);
  const before = fs.lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('Telemetry file exceeds safe bounds');
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > maxBytes) {
      throw new Error('Telemetry file exceeds safe bounds');
    }
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let size = 0;
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > maxBytes || size > stat.size) throw new Error('Telemetry file exceeds safe bounds');
    try { return { value: JSON.parse(buffer.subarray(0, size).toString('utf8')), bytes: size }; }
    catch { throw new Error('Invalid telemetry JSON'); }
  } finally { fs.closeSync(fd); }
}

/** Convenience reader for one document. */
export function readJsonFile(file, maxBytes = MAX_FILE_BYTES) {
  return readJsonDocument(file, maxBytes).value;
}

/** Publish complete JSON with no-clobber semantics, including against destination symlinks. */
export function writeNewJson(file, value) {
  const absolute = path.resolve(file);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Telemetry output exceeds safe bounds');
  const temp = path.join(path.dirname(absolute), `.ak-telemetry-${randomBytes(16).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    // A hard link publishes already-complete bytes atomically and fails if the destination exists.
    fs.linkSync(temp, absolute);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}

/** Explicit export enrolls a local installation; never silently replace a lost/corrupt identity. */
export function readOrCreateIdentity(directory) {
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw new Error('Telemetry identity directory must be private');
  }
  const file = path.join(root, 'identity.json');
  if (!fs.existsSync(file)) {
    try { writeNewJson(file, { installationId: randomUUID(), key: randomBytes(32).toString('hex') }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const fileStat = fs.lstatSync(file);
  if (process.platform !== 'win32' && (fileStat.mode & 0o077)) throw new Error('Telemetry identity must be private');
  const value = readJsonFile(file, 4096);
  if (!value || Object.keys(value).sort().join(',') !== 'installationId,key'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.installationId)
    || !/^[a-f0-9]{64}$/.test(value.key)) throw new Error('Invalid telemetry identity; restore its original private file');
  return value;
}
