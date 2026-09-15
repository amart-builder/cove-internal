import { createHash } from 'node:crypto';

export function floorFingerprint(candidate) {
  return createHash('sha256').update(JSON.stringify([
    candidate.title, candidate.dueAt, candidate.nextAction ?? null,
  ])).digest('hex');
}

export function unseenFloorCandidates(db, candidates) {
  const read = db.prepare('SELECT fingerprint FROM cove_floor_reminder_state WHERE ref_kind=? AND ref_id=?');
  return candidates.filter(candidate => read.get(candidate.refKind, candidate.refId)?.fingerprint !== floorFingerprint(candidate));
}

export function recordFloorNotice(db, candidate, now) {
  db.prepare(`INSERT INTO cove_floor_reminder_state(ref_kind,ref_id,fingerprint,noticed_at)
    VALUES(?,?,?,?) ON CONFLICT(ref_kind,ref_id) DO UPDATE SET fingerprint=excluded.fingerprint,noticed_at=excluded.noticed_at`)
    .run(candidate.refKind, candidate.refId, floorFingerprint(candidate), now.toISOString());
}

// Only a known failure releases this exact attempt; later changed work wins.
export function releaseFloorNotice(db, candidate) {
  db.prepare('DELETE FROM cove_floor_reminder_state WHERE ref_kind=? AND ref_id=? AND fingerprint=?')
    .run(candidate.refKind, candidate.refId, floorFingerprint(candidate));
}
