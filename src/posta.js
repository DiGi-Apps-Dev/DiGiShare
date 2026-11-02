import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// POSTA_FINTA=<cartella>: le email si scrivono
// come file JSON invece di partire. Serve SOLO alle prove automatiche; sul server non va impostata.

export function createMailer(env = process.env) {
  const host = String(env.SMTP_HOST || '').trim();
  const port = Number(env.SMTP_PORT || 465);
  const user = String(env.SMTP_USER || '').trim();
  const pass = String(env.SMTP_PASS || '');
  const from = String(env.SMTP_FROM || user).trim();
  const to = String(env.SECURITY_EMAIL_TO || '').trim();
  const finta = String(env.POSTA_FINTA || '').trim();
  if (finta) {
    mkdirSync(finta, { recursive: true });
    let n = 0;
    const scrivi = (dest, subject, text) => writeFileSync(join(finta, `${Date.now()}-${++n}.json`), JSON.stringify({ to: dest, subject, text }));
    return { configured: true, recipient: to || 'prova@esempio.test', async send(subject, text) { scrivi(to || 'prova@esempio.test', subject, text); }, async sendTo(dest, subject, text) { scrivi(dest, subject, text); }, close() {} };
  }
  const configured = Boolean(host && user && pass && from && to && port > 0 && port < 65536);
  const transport = configured ? nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 }) : null;
  return {
    configured,
    recipient: to,
    async send(subject, text) {
      if (!configured) throw new Error('Email di sicurezza non configurata.');
      return transport.sendMail({ from, to, subject, text });
    },
    // Email a un destinatario scelto: i link personali di DiGiShare.
    async sendTo(dest, subject, text) {
      if (!configured) throw new Error('Email non configurata.');
      await transport.sendMail({ from, to: dest, subject, text });
    },
    close() { transport?.close(); }
  };
}
