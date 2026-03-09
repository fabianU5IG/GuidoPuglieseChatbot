import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
    throw new Error(
        "Faltan TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN en variables de entorno.",
    );
}

const client = twilio(accountSid, authToken);

function normalizeWhatsAppAddress(value, fallback = "") {
    const raw = String(value || fallback || "").trim();

    if (!raw) {
        throw new Error("Número WhatsApp no configurado.");
    }

    // si ya viene como whatsapp:+573...
    if (raw.startsWith("whatsapp:")) {
        return raw;
    }

    // limpia espacios
    const cleaned = raw.replace(/\s+/g, "");

    // permite +573..., +1415..., etc.
    return `whatsapp:${cleaned}`;
}

const FROM_WHATSAPP = normalizeWhatsAppAddress(
    process.env.TWILIO_WHATSAPP_NUMBER,
    "+14155238886",
);

const SECRETARY_WHATSAPP = normalizeWhatsAppAddress(
    process.env.SECRETARY_WHATSAPP_NUMBER,
    "+573153573131",
);

export async function sendWhatsAppMessage(phone, body) {
    const to = normalizeWhatsAppAddress(phone);

    return client.messages.create({
        from: FROM_WHATSAPP,
        to,
        body,
    });
}

export async function notifySecretaryNewAppointment({
    fullName,
    phone,
    date,
    time,
    attentionType,
    redirectUrl,
}) {
    const message =
        `🆕 *Nuevo agendamiento iniciado*\n\n` +
        `👤 Paciente: ${fullName}\n` +
        `📞 Tel: ${phone}\n` +
        `📅 Fecha: ${date}\n` +
        `🕒 Hora: ${time}\n` +
        `🏥 Tipo: ${attentionType}\n\n` +
        `🔗 Doctoralia:\n${redirectUrl}`;

    return client.messages.create({
        from: FROM_WHATSAPP,
        to: SECRETARY_WHATSAPP,
        body: message,
    });
}
