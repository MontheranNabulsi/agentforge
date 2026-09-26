import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from '../observability/logger';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly transport: 'smtp' | 'log' | 'memory';
  send(email: OutgoingEmail): Promise<void>;
}

export class SmtpMailer implements Mailer {
  readonly transport = 'smtp' as const;
  private readonly transporter: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transporter = nodemailer.createTransport(smtpUrl);
  }

  async send(email: OutgoingEmail): Promise<void> {
    await this.transporter.sendMail({ from: this.from, ...email });
  }
}

/**
 * Used when no SMTP server is configured (for example a free deployment): the email is written
 * to the log instead of being sent. Useful in development; in production configure SMTP_URL.
 */
export class LogMailer implements Mailer {
  readonly transport = 'log' as const;
  constructor(private readonly logger: Logger) {}

  send(email: OutgoingEmail): Promise<void> {
    this.logger.info(
      { to: email.to, subject: email.subject, body: email.text },
      'email (log transport)',
    );
    return Promise.resolve();
  }
}

export class MemoryMailer implements Mailer {
  readonly transport = 'memory' as const;
  readonly sent: OutgoingEmail[] = [];
  send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
    return Promise.resolve();
  }
}
