const twilio = require("twilio");

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env");
  }

  return twilio(accountSid, authToken);
}

function getFromParams() {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_FROM; // e.g. "whatsapp:+1415XXXXXXX"

  if (messagingServiceSid) return { messagingServiceSid };
  if (from) return { from };

  throw new Error("Set either TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM in .env");
}

/**
 * Envia un Content Template (LIST / QUICK REPLY) por la API de Twilio.
 * - contentSid: SID del template en Content Template Builder
 * - contentVariables: { "1": "...", "2": "..." } (solo si tu template usa variables)
 */
async function sendContentTemplate({ to, contentSid, contentVariables }) {
  if (!to) throw new Error("Missing 'to'");
  if (!contentSid) throw new Error("Missing 'contentSid'");

  const client = getTwilioClient();
  const payload = {
    to,
    contentSid,
    ...getFromParams(),
  };

  if (contentVariables && Object.keys(contentVariables).length > 0) {
    payload.contentVariables = JSON.stringify(contentVariables);
  }

  return client.messages.create(payload);
}

module.exports = { sendContentTemplate };
