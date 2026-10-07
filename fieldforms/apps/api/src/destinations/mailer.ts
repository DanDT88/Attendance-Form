import nodemailer from 'nodemailer';
import type { Mailer } from './types.js';

/** The server's SMTP settings (email destinations need no connection of their own). */
export interface SmtpSettings {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (usually port 465). */
  secure: boolean;
  /** Refuse to send without STARTTLS (off only for a local mail catcher in development). */
  requireTLS: boolean;
  user?: string;
  password?: string;
  /** The From header, e.g. "FieldForms <fieldforms@example.co.za>". */
  from: string;
}

/**
 * The mailer for email destinations and delivery alerts. It returns the message id and the
 * server's reply line, which the delivery log keeps as evidence (a 250 means the relay accepted
 * the message, not that anyone read it).
 *
 * Timeouts are well inside an attempt's deadline, so a stalled server fails the attempt (and is
 * retried) instead of holding the delivery's lease. Message content only ever comes from the
 * buffers given: nodemailer may not read a file or fetch a URL for an attachment or the body.
 */
export function createSmtpMailer(s: SmtpSettings): Mailer {
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    requireTLS: !s.secure && s.requireTLS,
    auth: s.user ? { user: s.user, pass: s.password ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    dnsTimeout: 15_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  });
  return {
    async send(msg) {
      const info = await transport.sendMail({
        from: s.from,
        to: msg.to,
        cc: msg.cc?.length ? msg.cc : undefined,
        replyTo: msg.replyTo,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: msg.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
        headers: msg.headers,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return { messageId: info.messageId, response: info.response };
    },
  };
}
