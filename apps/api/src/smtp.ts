import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import SMTPConnection, { type SMTPConnectionOptions } from "nodemailer/lib/smtp-connection";

export type LoginCodeDelivery = {
  send(input: { recipient: string; code: string; expiresAt: Date }): Promise<void>;
};

export type SmtpDeliverySettings = {
  connection: SMTPConnectionOptions;
  /** The sender: a display name (possibly empty) and the bare address the envelope uses. */
  from: { name: string; address: string };
  auth?: { user: string; pass: string };
  deadlineMs: number;
};

/** Exactly one mailbox. A group, which a From header may not carry, is refused. */
function parseSender(value: string): { name: string; address: string } | null {
  const parsed = addressparser(value);
  const mailbox = parsed.length === 1 ? parsed[0] : undefined;
  if (!mailbox || "group" in mailbox || !mailbox.address || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mailbox.address)) return null;
  return { name: mailbox.name, address: mailbox.address };
}

const DELIVERY_DEADLINE_MS = 20_000;
// How long a server may keep the connection open after answering QUIT.
const QUIT_GRACE_MS = 2_000;

/** Validated server-side SMTP settings, or null when sign-in mail is not configured. */
export function smtpSettingsFromEnv(): SmtpDeliverySettings | null {
  const host = process.env.SMTP_HOST?.trim();
  const from = parseSender(process.env.SMTP_FROM?.trim() ?? "");
  const port = Number(process.env.SMTP_PORT);
  const tlsMode = process.env.SMTP_TLS_MODE;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (tlsMode !== "implicit" && tlsMode !== "starttls") return null;
  if (Boolean(user) !== Boolean(password)) return null;
  if (process.env.NODE_ENV === "production" && (!user || !password)) return null;
  return {
    connection: {
      host,
      port,
      // Certificate-verified TLS only: implicit TLS or mandatory STARTTLS, never
      // an opportunistic fallback to plaintext.
      secure: tlsMode === "implicit",
      requireTLS: tlsMode === "starttls",
      ignoreTLS: false,
      opportunisticTLS: false,
      // Explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 cannot switch certificate checks off.
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      logger: false,
      debug: false
    },
    from,
    auth: user && password ? { user, pass: password } : undefined,
    deadlineMs: DELIVERY_DEADLINE_MS
  };
}

/** Creates the narrowly configured server-side login-code transport, or null. */
export function createSmtpLoginCodeDelivery(): LoginCodeDelivery | null {
  const settings = smtpSettingsFromEnv();
  return settings ? smtpLoginCodeDelivery(settings) : null;
}

/**
 * Sends each code over its own SMTP connection. A pooled or shared transport
 * cannot interrupt a message already in flight, so the deadline would only
 * stop waiting; owning the connection lets it stop the exchange itself.
 */
export function smtpLoginCodeDelivery(settings: SmtpDeliverySettings): LoginCodeDelivery {
  return {
    async send({ recipient, code, expiresAt }) {
      const message = await new MailComposer({
        from: settings.from,
        to: recipient,
        subject: "Your MSVA sign-in code",
        text: `Your sign-in code is ${code}. It expires at ${expiresAt.toISOString()}.`,
        disableFileAccess: true,
        disableUrlAccess: true
      }).compile().build();
      const connection = new SMTPConnection(settings.connection);
      // Errors can still be emitted after the outcome is decided; an unhandled
      // "error" event would crash the process.
      let fail: (error: Error) => void = () => undefined;
      connection.on("error", (error: Error) => fail(error));
      let timer: NodeJS.Timeout | undefined;
      let delivered = false;
      try {
        await new Promise<void>((resolve, reject) => {
          fail = reject;
          timer = setTimeout(() => reject(new Error("SMTP delivery deadline exceeded")), settings.deadlineMs);
          connection.connect(() => {
            const sendMessage = () => connection.send({ from: settings.from.address, to: [recipient] }, message, (error) => (error ? reject(error) : resolve()));
            if (settings.auth) connection.login(settings.auth, (error) => (error ? reject(error) : sendMessage()));
            else sendMessage();
          });
        });
        delivered = true;
      } finally {
        clearTimeout(timer);
        fail = () => undefined;
        // After a failure or the deadline, close() unpipes any unfinished message
        // and sends nothing further, so a late server reply cannot complete it.
        if (delivered) {
          connection.quit();
          // quit() leaves closing to the server; one that never does must not
          // keep the socket.
          const socket = connection._socket;
          if (socket && !socket.destroyed) {
            const release = setTimeout(() => socket.destroy(), QUIT_GRACE_MS);
            release.unref();
            socket.once("close", () => clearTimeout(release));
          }
        } else {
          connection.close();
          // close() only half-closes a connected socket; release it outright.
          const socket = connection._socket;
          if (socket && !socket.destroyed) socket.destroy();
        }
      }
    }
  };
}
