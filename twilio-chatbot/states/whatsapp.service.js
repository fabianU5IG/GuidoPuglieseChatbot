import twilio from "twilio";

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
);

const FROM_WHATSAPP = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
const SECRETARY_WHATSAPP = "whatsapp:+573153573131";

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

    await client.messages.create({
        from: FROM_WHATSAPP,
        to: SECRETARY_WHATSAPP,
        body: message,
    });
}
