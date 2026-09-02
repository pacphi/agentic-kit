import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { sha256, stableJson } from '../hook-audit/common.mjs';
import { writePrivateFileAtomic } from '../file-write.mjs';
import { inspectHookTarget } from './fs-port.mjs';

export const HOOK_HEAL_RECEIPT_SCHEMA = 'hook-heal-receipt/v1';
const RECEIPT_ID = /^tx-[0-9TZ.-]+-[a-f0-9]{16}$/;

function receiptBody(receipt) {
  const body = { ...receipt };
  delete body.receiptDigest;
  return body;
}

function syncFileAndParent(file, fsImpl) {
  if (typeof fsImpl.fsyncSync !== 'function') return;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(file, 'r+');
    fsImpl.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
  if (process.platform === 'win32') return;
  try {
    descriptor = fsImpl.openSync(path.dirname(file), 'r');
    fsImpl.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

export function sealHookReceipt(receipt) {
  const body = receiptBody(receipt);
  return { ...body, receiptDigest: sha256(stableJson(body)) };
}

function assertPrivateDirectory(dir, fsImpl) {
  const stat = fsImpl.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`hook transaction path must be a non-symlink directory: ${dir}`);
  }
}

export function createHookTransactionDir(transactionsRoot, { fsImpl = fs, now = () => new Date() } = {}) {
  fsImpl.mkdirSync(transactionsRoot, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(transactionsRoot, fsImpl);
  fsImpl.chmodSync(transactionsRoot, 0o700);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const stamp = now().toISOString().replaceAll(':', '-');
    const id = `tx-${stamp}-${randomBytes(8).toString('hex')}`;
    const dir = path.join(transactionsRoot, id);
    try {
      fsImpl.mkdirSync(dir, { mode: 0o700 });
      assertPrivateDirectory(dir, fsImpl);
      return { id, dir, receiptFile: path.join(dir, 'receipt.json') };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not allocate a unique hook transaction directory');
}

export function writeHookReceipt(receiptFile, receipt, { fsImpl = fs } = {}) {
  const sealed = sealHookReceipt(receipt);
  writePrivateFileAtomic(receiptFile, `${JSON.stringify(sealed, null, 2)}\n`, { fsImpl });
  syncFileAndParent(receiptFile, fsImpl);
  return sealed;
}

export function readHookReceipt(transactionsRoot, receiptId, { fsImpl = fs } = {}) {
  if (!RECEIPT_ID.test(receiptId)) throw new TypeError('invalid hook receipt id');
  const dir = path.join(transactionsRoot, receiptId);
  const file = path.join(dir, 'receipt.json');
  assertPrivateDirectory(transactionsRoot, fsImpl);
  assertPrivateDirectory(dir, fsImpl);
  const snapshot = inspectHookTarget(file, dir, { fsImpl });
  const receipt = JSON.parse(snapshot.bytes.toString('utf8'));
  if (receipt.schemaVersion !== HOOK_HEAL_RECEIPT_SCHEMA) throw new Error('unsupported hook receipt schema');
  const expected = sha256(stableJson(receiptBody(receipt)));
  if (receipt.receiptDigest !== expected) throw new Error('hook receipt integrity check failed');
  return { dir, file, receipt };
}

export function lastHookReceiptId(transactionsRoot, { fsImpl = fs } = {}) {
  let entries;
  try { entries = fsImpl.readdirSync(transactionsRoot, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RECEIPT_ID.test(entry.name)) continue;
    try {
      const { receipt } = readHookReceipt(transactionsRoot, entry.name, { fsImpl });
      candidates.push(receipt);
    } catch { /* invalid receipts are not eligible for implicit --last */ }
  }
  candidates.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
  return candidates.at(-1)?.id ?? null;
}

export function unfinishedHookReceipts(transactionsRoot, { fsImpl = fs } = {}) {
  let entries;
  try { entries = fsImpl.readdirSync(transactionsRoot, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && RECEIPT_ID.test(entry.name)).flatMap((entry) => {
    try {
      const { receipt } = readHookReceipt(transactionsRoot, entry.name, { fsImpl });
      return ['prepared', 'applying', 'verifying', 'undoing', 'partial', 'failed'].includes(receipt.status) ? [receipt] : [];
    } catch { return []; }
  }).sort((a, b) => a.id.localeCompare(b.id));
}
