import {execFileSync} from 'node:child_process';
import {openLocalDatabase} from '../local/database';
import {coveEnv} from '../env';
import {nativeNotificationCommand} from '../intake/notification-transport.mjs';
import {sanitizeNonDirectBanner} from '../attention/safety.mjs';
import {notificationUrl} from '../attention/notification-links.mjs';
import {recordReceipt} from '../reliability/receipts';
import type {EmailClassification} from './classifier';

/** An email's claim of an outgoing charge warrants review, not trust or payment. */
export function isChargeNotice(input: {subject: string; text: string}): boolean {
  const subject = input.subject.slice(0, 2000).replace(/[’‘]/g, "'");
  // A refund may quote the original charge. It is not a new outgoing payment.
  if (/\b(?:refund(?:ed)?|charge (?:reversal|reversed|voided))\b/i.test(subject) &&
      !/\b(?:denied|failed|rejected)\b/i.test(subject)) return false;
  const content = `${subject}\n${input.text.slice(0, 8000)}`.replace(/[’‘]/g, "'");
  const hasMoney = /[$€£¥]\s*\d|\b\d[\d,.]*\s*(?:USD|EUR|GBP|CAD|AUD)\b/i.test(content);
  return content.split(/\r?\n|(?<=[.!?])\s+/).some(part => {
    const line = part.replace(/\s+/g, ' ');
    if (/\b(?:not|never|won't)\s+(?:(?:be|been|being|have|has|yet|actually|successfully)\s+){0,4}(?:charged|debited|billed|paid)\b/i.test(line)) return false;
    if (/\b(?:your|the|a|our)\s+(?:customer|client|buyer|guest|subscriber)\b.{0,70}\b(?:charged|debited|billed|paid|payment)\b/i.test(line)) return false;
    if (/\b(?:payment|transfer|deposit|credit)\b.{0,60}\b(?:received from|from (?:your |a |the )?(?:customer|client|buyer)|into your|credited to)\b/i.test(line)) return false;
    return /\b(?:has been|have been|was|were|being|will be)\s+(?:successfully\s+)?(?:charged|debited|billed)\b/i.test(line) ||
      /\b(?:charged|debited|billed)\s+(?:your|the)\b.{0,70}\b(?:account|card)\b/i.test(line) ||
      /\b(?:charged|debited|billed)\s+[$€£¥]\s*\d/i.test(line) ||
      (hasMoney && (
        /\byou (?:paid|spent)\b|\bcard purchase\b.{0,70}\b(?:approved|completed|posted)\b/i.test(line) ||
        /\b(?:ACH debit|direct debit)\b.{0,80}\b(?:your|from|processed|scheduled)\b/i.test(line) ||
        /\b(?:we received your|your payment|autopay|auto-pay|automatic payment|direct debit)\b.{0,80}\b(?:payment|processed|scheduled|successful|completed|paid)\b/i.test(line) ||
        /\b(?:your receipt|receipt for your|payment receipt|payment confirmation|your payment was received)\b/i.test(line) ||
        /\b(?:subscription|membership)\b.{0,50}\b(?:renewed|renews|will renew|renewal charge)\b/i.test(line)
      ));
  });
}

export function protectChargeNotice(classified: EmailClassification, input: {subject: string; text: string}): EmailClassification {
  if (!isChargeNotice(input)) return classified;
  return {
    ...classified,
    bucket: classified.bucket === 'reply' ? 'reply' : 'action',
    summary: `Charge notice: ${input.subject.trim() || 'An email reports a charge to your account.'}`.slice(0, 1000),
    recommendedAction: classified.bucket === 'reply' && classified.recommendedAction
      ? classified.recommendedAction
      : 'Review the charge, merchant and amount. Confirm that you recognize it before marking this email done.',
    draftBody: classified.bucket === 'reply' ? classified.draftBody : null,
    modelVersion: `${classified.modelVersion}:charge-review-v1`,
  };
}

/** The existing durable artifact job owns delivery; retries never blindly resend. */
export function deliverChargeNotice(input: {jobId: string; messageId: string; emailItemId: string; dbPath?: string; now?: Date}, dependencies: {
  notify?: (subject: string, openUrl: string) => void;
} = {}): 'accepted' | 'deduped' | 'stale' {
  const now = (input.now ?? new Date()).toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    const claim = db.transaction(() => {
      const item = db.prepare(`SELECT subject FROM email_items
        WHERE id=? AND latest_inbound_message_id=? AND status='pending' AND workflow_state='open' AND bucket IN ('action','reply')`)
        .get(input.emailItemId, input.messageId) as {subject: string} | undefined;
      if (!item) return {status: 'stale' as const};
      const existing = db.prepare(`SELECT json_extract(payload,'$.financialNoticeDelivery') AS delivery
        FROM cove_jobs WHERE type='email-artifacts' AND json_extract(payload,'$.messageId')=?
        AND json_extract(payload,'$.financialNoticeDelivery') IS NOT NULL LIMIT 1`)
        .get(input.messageId) as {delivery: string} | undefined;
      if (existing?.delivery === 'accepted') return {status: 'deduped' as const};
      if (existing) throw new Error('Cove could not confirm the charge notification after an interrupted or failed delivery. The email is still waiting for review.');
      const saved = db.prepare(`UPDATE cove_jobs SET payload=json_set(payload,'$.financialNoticeDelivery','attempting')
        WHERE id=? AND type='email-artifacts' AND json_extract(payload,'$.messageId')=?
        AND json_extract(payload,'$.financialChargeNotice')=1`)
        .run(input.jobId, input.messageId);
      if (saved.changes !== 1) throw new Error('Charge notification has no durable delivery job.');
      return {status: 'claimed' as const, subject: item.subject};
    }).immediate();
    if (claim.status !== 'claimed') return claim.status;
    try {
      const openUrl = new URL(notificationUrl({email: true}));
      openUrl.searchParams.set('notice', 'task');
      (dependencies.notify ?? ((subject, url) => {
        const command = nativeNotificationCommand(sanitizeNonDirectBanner(subject, 'Charge notice from email'), {
          title: 'Cove', subtitle: 'Review this charge', openUrl: url, group: `cove-charge-${input.messageId}`, sound: 'Glass',
        }, {notificationAppPath: coveEnv('NOTIFICATION_APP')});
        execFileSync(command.executable, command.args, {timeout: 10_000, stdio: 'pipe'});
      }))(claim.subject, openUrl.toString());
      db.prepare("UPDATE cove_jobs SET payload=json_set(payload,'$.financialNoticeDelivery','accepted') WHERE id=?").run(input.jobId);
    } catch (error) {
      db.prepare("UPDATE cove_jobs SET payload=json_set(payload,'$.financialNoticeDelivery','failed') WHERE id=?").run(input.jobId);
      recordReceipt({source:'email-charge-notification',startedAt:now,outcome:'failed',
        summary:'A charge email is waiting for review, but Cove could not confirm its native notification.',
        actions:{messageId:input.messageId,emailItemId:input.emailItemId},failureKey:input.messageId,dbPath:input.dbPath});
      throw error;
    }
    recordReceipt({source:'email-charge-notification',startedAt:now,outcome:'success',
      summary:'A charge email is waiting for review and its notification was accepted by the native sender.',
      actions:{messageId:input.messageId,emailItemId:input.emailItemId},dbPath:input.dbPath});
    return 'accepted';
  } finally {db.close();}
}
