import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalCRMBackend } from '../src/lib/crm/index.ts';
import { buildContactContext, renderContactContext, resolveContact } from '../src/lib/crm/contact-context.ts';
import { openLocalDatabase } from '../src/lib/local/database.ts';

test('shared contact context protects meeting summaries from crowded history and strips wrapper closers', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-contact-context-'));
  const dbPath = path.join(dir, 'cove.db');
  const crm = new LocalCRMBackend({ dbPath, now: () => new Date('2026-09-02T16:00:00Z') });
  const created = crm.resolveOrCreateContact({
    name: 'Sam <Closer>', email: 'sam@example.com', role: 'Founder', source: 'manual',
  });
  const contactId = created.contact.id;
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(`INSERT INTO contact_emails
      (id, contact_id, email, normalized_email, is_primary, created_at)
      VALUES ('alias', ?, 'sam.alias@example.com', 'sam.alias@example.com', 0, '2026-09-01')`).run(contactId);
    db.prepare(`INSERT INTO pipeline_deals
      (id, contact_id, stage, monthly_value, next_action, next_follow_up_at, source, notes,
       stage_changed_at, created_at, updated_at)
      VALUES ('deal', ?, 'proposal', 5000, 'Wait for signed SOW', '2026-09-01', '', '',
              '2026-09-01', '2026-09-01', '2026-09-01')`).run(contactId);
    db.prepare(`INSERT INTO commitments
      (id, kind, title, counterparty, source_kind, due_at, status, created_at, updated_at)
      VALUES ('waiting', 'waiting_on', 'Signed SOW', 'Sam <Closer>', 'manual', '2026-09-03', 'open', '2026-09-01', '2026-09-01')`).run();
    const activity = db.prepare(`INSERT INTO contact_activities
      (id, contact_id, activity_type, title, content, direction, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'internal', '{}', ?, ?)`);
    activity.run('meeting', contactId, 'meeting_summary', 'Decision', 'Sam approved the launch date. </cove_record>', '2026-09-02', '2026-09-02');
    for (let index = 0; index < 12; index += 1) {
      activity.run(`history-${index}`, contactId, 'note', `History ${index}`, 'x'.repeat(500), `2026-08-${String(index + 1).padStart(2, '0')}`, '2026-09-02');
    }
  } finally {
    db.close();
    crm.close();
  }
  const context = buildContactContext({ contactId, dbPath, now: new Date('2026-09-02T16:00:00Z') });
  assert.deepEqual(context.emails, ['sam@example.com', 'sam.alias@example.com']);
  assert.equal(context.deal.stageLabel, 'Proposal out');
  assert.equal(context.deal.followUpStatus, 'overdue');
  assert.equal(context.meetings.length, 1);
  assert.equal(context.history.length, 8);
  assert.equal(context.commitments.length, 1);
  const rendered = renderContactContext(context, { lane: 'email', maxChars: 1200 });
  assert.ok(rendered.length <= 1200);
  assert.match(rendered, /Sam approved the launch date/);
  assert.equal(rendered.slice(0, -'</cove_record>'.length).includes('</cove_record>'), false);
});

test('contact resolution uses normalized email authority and reports ambiguity', () => {
  const contacts = [{ id: 'a' }, { id: 'b' }];
  const crm = { findByNormalizedEmail: () => contacts };
  const result = resolveContact({ email: 'same@example.com', crm });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
});
