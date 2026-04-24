import nodemailer, { type Transporter, type SendMailOptions } from 'nodemailer';

/** Escape user-supplied strings before embedding them in HTML templates */
function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export type EmailSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface SendEmailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export interface ReportData {
  [key: string]: unknown;
}

export class EmailTool {
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor() {
    const host = process.env['SMTP_HOST'];
    const port = process.env['SMTP_PORT'];
    const user = process.env['SMTP_USER'];
    const password = process.env['SMTP_PASSWORD'];

    if (!host) {
      throw new Error('SMTP_HOST environment variable is required');
    }
    if (!user) {
      throw new Error('SMTP_USER environment variable is required');
    }
    if (!password) {
      throw new Error('SMTP_PASSWORD environment variable is required');
    }

    this.fromAddress = user;

    const smtpPort = port ? parseInt(port, 10) : 587;
    this.transporter = nodemailer.createTransport({
      host,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user,
        pass: password,
      },
      tls: {
        rejectUnauthorized: true,
      },
    });
  }

  /**
   * Send an email with HTML (and optionally plain-text) body.
   */
  async sendEmail(
    to: string | string[],
    subject: string,
    htmlBody: string,
    textBody?: string,
  ): Promise<SendEmailResult> {
    const recipients = Array.isArray(to) ? to.join(', ') : to;

    const mailOptions: SendMailOptions = {
      from: this.fromAddress,
      to: recipients,
      subject,
      html: htmlBody,
      ...(textBody ? { text: textBody } : {}),
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const info = await this.transporter.sendMail(mailOptions);
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        messageId: info.messageId as string,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        accepted: (info.accepted as string[]) ?? [],
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        rejected: (info.rejected as string[]) ?? [],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`sendEmail to "${recipients}" failed: ${msg}`);
    }
  }

  /**
   * Send a severity-stamped alert email using a built-in HTML template.
   */
  async sendAlert(
    severity: EmailSeverity,
    subject: string,
    details: string,
  ): Promise<SendEmailResult> {
    const alertRecipient = process.env['ALERT_EMAIL'] ?? this.fromAddress;

    const colorMap: Record<EmailSeverity, string> = {
      info: '#2196f3',
      warning: '#ff9800',
      error: '#f44336',
      critical: '#7b0000',
    };
    const color = colorMap[severity];

    const safeSubject = escHtml(subject);
    const safeDetails = escHtml(details).replace(/\n/g, '<br />');

    const htmlBody = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${safeSubject}</title>
</head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 24px;">
  <div style="max-width: 600px; margin: 0 auto; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.12);">
    <div style="background: ${color}; padding: 16px 24px;">
      <h1 style="color: #fff; margin: 0; font-size: 18px;">
        [${severity.toUpperCase()}] ${safeSubject}
      </h1>
    </div>
    <div style="padding: 24px;">
      <p style="margin: 0 0 12px; color: #333; line-height: 1.6;">${safeDetails}</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;" />
      <p style="font-size: 12px; color: #999; margin: 0;">
        Sent by OpenClaw Teams &bull; ${new Date().toISOString()}
      </p>
    </div>
  </div>
</body>
</html>`;

    const textBody = `[${severity.toUpperCase()}] ${subject}\n\n${details}\n\nSent by OpenClaw Teams — ${new Date().toISOString()}`;

    return this.sendEmail(
      alertRecipient,
      `[${severity.toUpperCase()}] ${subject}`,
      htmlBody,
      textBody,
    );
  }

  /**
   * Send a formatted HTML report email to one or more recipients.
   */
  async sendReport(
    to: string | string[],
    reportName: string,
    data: ReportData,
  ): Promise<SendEmailResult> {
    const subject = `Report: ${reportName} — ${new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })}`;

    const rowsHtml = Object.entries(data)
      .map(
        ([key, value]) => `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-weight: 600; color: #555; width: 40%;">${key}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #333;">${this.formatValue(value)}</td>
        </tr>`,
      )
      .join('');

    const htmlBody = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${subject}</title>
</head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 24px;">
  <div style="max-width: 700px; margin: 0 auto; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.12);">
    <div style="background: #1565c0; padding: 16px 24px;">
      <h1 style="color: #fff; margin: 0; font-size: 20px;">${reportName}</h1>
      <p style="color: #90caf9; margin: 4px 0 0; font-size: 13px;">${new Date().toISOString()}</p>
    </div>
    <div style="padding: 24px;">
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="font-size: 12px; color: #999; margin: 0;">
        OpenClaw Teams automated report &bull; ${new Date().toISOString()}
      </p>
    </div>
  </div>
</body>
</html>`;

    const textLines = Object.entries(data)
      .map(([k, v]) => `${k}: ${this.formatValue(v)}`)
      .join('\n');
    const textBody = `${reportName}\n${'='.repeat(reportName.length)}\n${textLines}\n\nOpenClaw Teams automated report — ${new Date().toISOString()}`;

    return this.sendEmail(to, subject, htmlBody, textBody);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private formatValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '—';
    }
    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  }
}
