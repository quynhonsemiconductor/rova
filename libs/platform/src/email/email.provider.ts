/**
 * IEmailProvider — provider-agnostic transport interface.
 *
 * Swap AWS SES ↔ Brevo ↔ Resend ↔ SMTP by changing the registered provider
 * in PlatformModule without touching any business logic.
 */

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

/** The hardest a single provider send may take; equal to the EMAIL resilience preset's timeout. The relay's lease is sized from it. */
export const EMAIL_SEND_TIMEOUT_MS = 30_000;

/**
 * Email category controls which RFC-compliance headers are added by the
 * transport layer:
 *
 * - 'transactional' — password-reset, invitation, account-verification, etc.
 *   These are 1:1 messages triggered by user action.  Do NOT add
 *   List-Unsubscribe headers — they look like bulk spam to spam filters and
 *   are not required by Google/Yahoo 2024 rules for transactional mail.
 *
 * - 'marketing' — newsletters, digests, campaigns.  Google/Yahoo 2024 rules
 *   REQUIRE `List-Unsubscribe` + `List-Unsubscribe-Post` for bulk senders
 *   (>5 000 messages/day to Gmail).  Add `Precedence: bulk` here.
 *
 * - 'notification' — system alerts, activity digests.  Add List-Unsubscribe
 *   if the user can opt-out of them in settings.
 */
export type EmailCategory = 'transactional' | 'notification' | 'marketing';

export interface EmailPayload {
  to: string;
  /** Formatted "Display Name <address@domain.com>" sender. `EmailService` resolves
   *  this ONCE from MAIL_FROM_NAME + MAIL_FROM_EMAIL and always passes it explicitly;
   *  a provider that receives this absent MUST throw rather than fall back to a
   *  hard-coded or provider-level default (see resend.provider.ts / ses.provider.ts).
   *  Optional only so a caller invoking a provider directly (tests, the dev transport)
   *  is not forced to fabricate one. */
  from?: string;
  /** Reply-To address. Defaults to MAIL_REPLY_TO config value. */
  replyTo?: string;
  subject: string;
  /** Full HTML body. Falls back to text if not rendered by template. */
  html: string;
  /** Plain-text fallback — always required for accessibility + spam score. */
  text: string;
  /**
   * Controls transport-level headers:
   * - 'transactional' (default) — no List-Unsubscribe, no Precedence header.
   * - 'notification' — adds List-Unsubscribe for user opt-out.
   * - 'marketing' — adds List-Unsubscribe, Precedence: bulk.
   */
  category?: EmailCategory;
  /** Stable idempotency key — providers use this to deduplicate retries.
   *  Defaults to a random UUID if not supplied. */
  idempotencyKey?: string;
}

/**
 * What a transport reports back on acceptance. `messageId` is the provider's own id for
 * the send — SES's `MessageId`, Resend's email id — and it is how the asynchronous
 * feedback loop matches a later bounce/complaint event to the row that sent it. NULL
 * means the provider has none to give (the dev transport), and a row sent without one
 * simply cannot be bounce-matched; that is honest, not an error.
 */
export interface EmailSendResult {
  messageId: string | null;
}

/** What the caller can hand a send besides the message. */
export interface EmailSendOptions {
  /**
   * Aborted when the caller's deadline passes. A provider that can cancel (Graph) cancels the request, its in-place retries and any wait; one
   * that cannot ignores it.
   */
  signal?: AbortSignal;
}

export interface IEmailProvider {
  send(payload: EmailPayload, options?: EmailSendOptions): Promise<EmailSendResult>;
}
