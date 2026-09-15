import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { textDeliveryUncertain } from '../intake/notification-transport.mjs';

function writeReceipt(file, record) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    const directory = openSync(path.dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Keep ninety days of diagnostic history, including unresolved attempts.
// Floor deduplication lives in SQLite and does not depend on receipt retention.
export function pruneNotificationReceipts(dataDir, now = new Date()) {
  const directory = path.join(dataDir, 'notification-deliveries');
  let names;
  try { names = readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const cutoff = now.getTime() - 90 * 86400000;
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      if (!lstatSync(file).isFile()) continue;
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (record.version === 1 && name === `${record.id}.json` && Date.parse(record.claimedAt) < cutoff) unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Record the handoff, not a delivery/read confirmation. Interrupted claimed
 * receipts remain evidence for review; this helper never retries a send. */
export function executeNotificationDelivery({ dataDir, channel, reference, content, now = () => new Date() }, send) {
  if (!['native', 'imessage', 'telegram'].includes(channel)) throw new Error('notification_receipt_channel_invalid');
  if (typeof reference !== 'string' || !reference.trim() || reference.length > 1000) throw new Error('notification_receipt_reference_invalid');
  if (typeof content !== 'string' || typeof send !== 'function') throw new Error('notification_receipt_input_invalid');
  const timestamp = () => (typeof now === 'function' ? now() : now).toISOString();
  const directory = path.join(dataDir, 'notification-deliveries');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  // Cleanup cannot turn a pending alarm into a failed delivery.
  try { pruneNotificationReceipts(dataDir, new Date(timestamp())); } catch { /* Keep evidence for a later cleanup attempt. */ }
  const id = randomUUID();
  const file = path.join(directory, `${id}.json`);
  const receipt = {
    version: 1, id, channel, reference, status: 'claimed', claimedAt: timestamp(),
    content: content.slice(0, 2000), contentTruncated: content.length > 2000,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
  // Failure here prevents transport execution: no unrecorded attempt is made.
  writeReceipt(file, receipt);
  let result;
  try {
    result = send();
    if (result && typeof result.then === 'function') {
      throw Object.assign(new Error('notification_delivery_async_callback_unsupported'), { deliveryUncertain: true });
    }
  } catch (error) {
    const uncertain = error?.deliveryUncertain === true || textDeliveryUncertain(error);
    try {
      writeReceipt(file, {
        ...receipt, status: uncertain ? 'uncertain' : 'failed', finishedAt: timestamp(),
        result: uncertain ? 'transport_outcome_unconfirmed' : 'transport_rejected',
      });
    } catch { /* Preserve the claimed receipt and the original transport error. */ }
    throw error;
  }
  try {
    writeReceipt(file, { ...receipt, status: 'accepted', finishedAt: timestamp(), result: 'transport_accepted_not_delivery_confirmed' });
  } catch {
    // The send has happened. Never call this a known transport failure or retry.
    throw Object.assign(new Error('Notification transport returned, but its receipt could not be finalized; delivery is unconfirmed.'), {
      code: 'NOTIFICATION_RECEIPT_UNCONFIRMED', deliveryUncertain: true,
    });
  }
  return result;
}
