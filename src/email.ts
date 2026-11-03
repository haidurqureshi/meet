import type { Env } from "./env";

export type Mail = { to: string; subject: string; text: string; html: string };

/** Never throws. Returns true if Cloudflare accepted the message. */
export async function sendEmail(env: Env, msg: Mail): Promise<boolean> {
  const from = env.EMAIL_FROM || "no-reply@known.org.uk";
  if (env.EMAIL_DEV_LOG === "1") console.log(`[email:dev] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
  try {
    if (!env.EMAIL) throw new Error("EMAIL binding is not configured");
    await env.EMAIL.send({ to: msg.to, from: { email: from, name: env.APP_NAME }, subject: msg.subject, text: msg.text, html: msg.html });
    return true;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error(`Email to ${msg.to.replace(/(.).+(@.+)/, "$1***$2")} failed:`, e.code ?? "", e.message ?? err);
    return false;
  }
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function layout(app: string, heading: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#F7F2ED;font-family:Arial,Helvetica,sans-serif;color:#171717;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 28px 8px;font-size:22px;font-weight:bold;">${esc(app)}</td></tr>
<tr><td style="padding:8px 28px 0;font-size:18px;font-weight:bold;">${esc(heading)}</td></tr>
<tr><td style="padding:12px 28px 28px;font-size:15px;line-height:1.6;">${body}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href: string, label: string) =>
  `<p style="margin:24px 0;"><a href="${esc(href)}" style="background:#9DD8EC;color:#171717;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px;display:inline-block;">${esc(label)}</a></p><p style="font-size:13px;color:#555;">Or paste this into your browser:<br><span style="word-break:break-all;">${esc(href)}</span></p>`;

const first = (name: string) => name.split(" ")[0] || "there";

export function verifyEmail(app: string, to: string, name: string, link: string): Mail {
  return {
    to,
    subject: `Confirm your email for ${app}`,
    text: `Hi ${first(name)},\n\nPlease confirm your email address to finish setting up your ${app} account (the link works for 48 hours):\n\n${link}\n\nIf you didn't create an account, you can ignore this email.\n\n${app}`,
    html: layout(app, "Confirm your email", `<p>Hi ${esc(first(name))},</p><p>Please confirm your email address to finish setting up your account. The link works for 48 hours.</p>${button(link, "Confirm email")}<p style="font-size:13px;color:#555;">If you didn't create an account, you can ignore this email.</p>`),
  };
}

export function resetEmail(app: string, to: string, name: string, link: string): Mail {
  return {
    to,
    subject: `Reset your ${app} password`,
    text: `Hi ${first(name)},\n\nWe received a request to reset your ${app} password. Use this link within 1 hour:\n\n${link}\n\nIf you didn't ask for this, you can ignore this email: your password won't change.\n\n${app}`,
    html: layout(app, "Reset your password", `<p>Hi ${esc(first(name))},</p><p>We received a request to reset your password. The link works for 1 hour.</p>${button(link, "Choose a new password")}<p style="font-size:13px;color:#555;">If you didn't ask for this, you can ignore this email and your password won't change.</p>`),
  };
}

export function passwordChangedEmail(app: string, to: string, name: string): Mail {
  return {
    to,
    subject: `Your ${app} password was changed`,
    text: `Hi ${first(name)},\n\nThe password for your ${app} account was just changed. If this was you, there's nothing more to do. If it wasn't you, reset your password straight away.\n\n${app}`,
    html: layout(app, "Your password was changed", `<p>Hi ${esc(first(name))},</p><p>The password for your account was just changed. If this was you, there's nothing more to do.</p><p>If it wasn't you, please reset your password straight away.</p>`),
  };
}

export function inviteEmail(
  app: string,
  to: string,
  host: { name: string; email: string },
  m: { title: string; when: string; durationMin: number; link: string; note: string }
): Mail {
  const noteText = m.note ? `\n"${m.note}"\n` : "";
  return {
    to,
    subject: `${host.name} invited you to "${m.title}"`,
    text: `${host.name} (${host.email}) invited you to a video meeting.\n\n${m.title}\n${m.when} (${m.durationMin} minutes)\n${noteText}\nJoin with this link (no account needed):\n${m.link}\n\nThe link opens 15 minutes before the start. If you weren't expecting this invitation, you can ignore it.\n\n${app}`,
    html: layout(
      app,
      "You're invited to a meeting",
      `<p><strong>${esc(host.name)}</strong> (${esc(host.email)}) invited you to a video meeting.</p>
<p style="font-size:17px;margin:16px 0 4px;"><strong>${esc(m.title)}</strong></p>
<p style="margin:0;">${esc(m.when)} &middot; ${m.durationMin} minutes</p>
${m.note ? `<p style="margin:16px 0;padding:10px 14px;background:#F7F2ED;border-radius:10px;white-space:pre-wrap;">${esc(m.note)}</p>` : ""}
${button(m.link, "Join the meeting")}
<p style="font-size:13px;color:#555;">No account needed. The link opens 15 minutes before the start. If you weren't expecting this invitation, you can ignore it.</p>`
    ),
  };
}

/** "Mon 2 Nov 2026, 16:00 GMT" in the given time zone. */
export function formatWhen(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: tz }).format(new Date(ms)) + ` (${tz})`;
  } catch {
    return new Date(ms).toUTCString();
  }
}
