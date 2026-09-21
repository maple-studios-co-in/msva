import nodemailer from "nodemailer";

export type LoginCodeDelivery = {
  send(input: { recipient: string; code: string; expiresAt: Date }): Promise<void>;
};

const DELIVERY_DEADLINE_MS = 20_000;

/** Creates the narrowly configured server-side login-code transport, or null. */
export function createSmtpLoginCodeDelivery(): LoginCodeDelivery | null {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.SMTP_FROM?.trim();
  const port = Number(process.env.SMTP_PORT);
  const tlsMode = process.env.SMTP_TLS_MODE;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (tlsMode !== "implicit" && tlsMode !== "starttls") return null;
  if (Boolean(user) !== Boolean(password)) return null;
  if (process.env.NODE_ENV === "production" && (!user || !password)) return null;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: tlsMode === "implicit",
    requireTLS: tlsMode === "starttls",
    auth: user && password ? { user, pass: password } : undefined,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000
  });

  return {
    async send({ recipient, code, expiresAt }) {
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("SMTP delivery deadline exceeded")), DELIVERY_DEADLINE_MS).unref();
      });
      try {
        await Promise.race([
          transport.sendMail({
            from,
            to: recipient,
            subject: "Your MSVA sign-in code",
            text: `Your sign-in code is ${code}. It expires at ${expiresAt.toISOString()}.`,
            disableFileAccess: true,
            disableUrlAccess: true
          }),
          timeout
        ]);
      } finally {
        transport.close();
      }
    }
  };
}
