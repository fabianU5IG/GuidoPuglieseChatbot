import "dotenv/config";
import twilio from "twilio";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function main() {
    const friendlyName = "notificacion_secretaria_solicitud";
    const body =
        "📥 *Solicitud para secretaria*\n\n👤 Paciente: {{1}}\n📞 Tel: {{2}}\n📌 Motivo: {{3}}\n📝 Mensaje: {{4}}\n\n_Notificación automática del chatbot._";

    const created = await client.content.v1.contents.create({
        friendly_name: friendlyName,
        language: "es_CO",
        variables: {
            "1": "Paciente Ejemplo",
            "2": "+573000000000",
            "3": "Solicitud general a secretaria",
            "4": "Sin mensaje adicional",
        },
        types: {
            "twilio/text": { body },
        },
    });

    console.log("Creada:", created.sid, created.friendlyName);

    const approval = await client.content.v1
        .contents(created.sid)
        .approvalCreate.create({ name: friendlyName, category: "UTILITY" });

    console.log("Aprobacion enviada:", approval.status);
    console.log("\nSID NUEVO:", created.sid);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
