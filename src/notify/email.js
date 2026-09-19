import { config } from '../config.js';
import { log } from '../util/log.js';

/**
 * Email via Resend's HTTP API (zero dependencies) or, optionally, SMTP.
 *
 * SMTP is intentionally a dynamic import of nodemailer: the base image ships
 * with no dependencies at all, and only an operator who actually wants SMTP
 * needs to install one. Hand-rolling SMTP AUTH here would have been code I
 * could not test from the build environment, which is not a good trade for
 * a notification path you need to trust.
 */
export async function sendEmail({ subject, text, html } = {}) {
  const provider = config.mailProvider;
  if (provider === 'none' || !config.mailTo.length) {
    return { sent: false, reason: 'email not configured' };
  }

  try {
    if (provider === 'resend') return await viaResend({ subject, text, html });
    if (provider === 'smtp') return await viaSmtp({ subject, text, html });
    return { sent: false, reason: `unknown MAIL_PROVIDER "${provider}"` };
  } catch (err) {
    log.warn(`email: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

async function viaResend({ subject, text, html }) {
  if (!config.resendApiKey) throw new Error('RESEND_API_KEY not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.mailFrom,
      to: config.mailTo,
      subject,
      text,
      ...(html ? { html } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  log.info(`email: sent to ${config.mailTo.length} recipient(s) via Resend`);
  return { sent: true };
}

async function viaSmtp({ subject, text, html }) {
  if (!config.smtpUrl) throw new Error('SMTP_URL not set');
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    throw new Error('MAIL_PROVIDER=smtp requires: npm install nodemailer');
  }
  const transport = nodemailer.createTransport(config.smtpUrl);
  await transport.sendMail({
    from: config.mailFrom,
    to: config.mailTo.join(', '),
    subject,
    text,
    ...(html ? { html } : {}),
  });
  log.info(`email: sent to ${config.mailTo.length} recipient(s) via SMTP`);
  return { sent: true };
}
