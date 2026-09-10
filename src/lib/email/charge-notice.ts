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
