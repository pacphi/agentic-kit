import fs from 'node:fs';
import path from 'node:path';
import { readIndex } from '../usage-index.mjs';
import { maintenanceControlDir } from '../paths.mjs';
import { createInventorySnapshotStore } from '../maintenance/management/service-store.mjs';
import { listMaintenanceReceiptsReadOnly } from '../maintenance/transaction-store.mjs';
import { createSnapshot } from './projection.mjs';

function retainedInventory() {
  return createInventorySnapshotStore(path.join(maintenanceControlDir(), 'management'), { fsImpl: fs }).read();
}
function retainedReceipts() {
  const root = path.join(maintenanceControlDir(), 'transactions');
  // No store is unavailable evidence; it is not proof that no action ever occurred.
  if (!fs.existsSync(root)) return null;
  return listMaintenanceReceiptsReadOnly(root);
}
async function evidence(read) {
  try { return await read(); } catch { return null; }
}

/** Sources are independent; one failed reader cannot manufacture successful empty evidence. */
export async function collectSnapshot({ identity, producerVersion, days = 30,
  generatedAt = new Date().toISOString(), readUsage = readIndex,
  readInventory = retainedInventory, readReceipts = retainedReceipts }) {
  const [usage, inventory, receipts] = await Promise.all([
    evidence(() => readUsage({ days, now: Date.parse(generatedAt), maxAgeMs: 0 })),
    evidence(readInventory), evidence(readReceipts),
  ]);
  return createSnapshot({ identity, producerVersion, days, generatedAt, usage, inventory, receipts });
}
