import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

// SMTP_URL tanımlıysa gerçekten gönderir; değilse (yerel geliştirme) yalnızca loglar.
@Injectable()
export class MailService {
  private readonly logger = new Logger('MailService');
  private readonly transport?: Transporter;
  private readonly from: string;

  constructor(config: ConfigService) {
    const url = config.get<string>('SMTP_URL');
    this.transport = url ? createTransport(url) : undefined;
    this.from = config.getOrThrow<string>('MAIL_FROM');
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transport) {
      this.logger.log(`[SMTP kapalı] ${message.to} · ${message.subject}\n${message.text}`);
      return;
    }
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
