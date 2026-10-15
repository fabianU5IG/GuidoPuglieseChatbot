// Resumen nocturno para secretaría de las citas que quedaron en FAILED en
// saludtools_jobs (agotaron todos sus reintentos sin lograr sincronizar con
// Saludtools). El paciente de cada una ya cree que su cita está agendada
// (ver optimisticPatientConfirm en agendar.state.js), así que estas son las
// que necesitan que alguien las agende a mano en Saludtools -- de no
// avisarse, quedarían invisibles hasta que alguien entrara al panel a
// preguntar por casualidad.
//
// Uso (pensado para cron, una vez por noche):
//   node scripts/nightly-failed-jobs-digest.mjs

import "dotenv/config";
import { db } from "../db/mysql.js";
import { getRecentFailedSaludtoolsJobs } from "../services/saludtools-jobs.service.js";
import { sendWhatsAppMessage } from "../services/whatsapp.service.js";

const PREVIEW_LIMIT = 10;

function describeJob(job) {
    const payload = job.payload || {};
    const appt = payload.appointmentBody || {};
    const name = payload.fullName || "Paciente sin nombre";
    const when =
        appt.startAppointment ||
        (payload.dateLabel && payload.timeLabel
            ? `${payload.dateLabel} ${payload.timeLabel}`
            : "fecha sin confirmar");

    return `• ${name} — 📞 ${job.phone} — 📅 ${when}`;
}

async function main() {
    const jobs = await getRecentFailedSaludtoolsJobs(200);

    if (!jobs.length) {
        console.log("Sin citas fallidas pendientes, no se envía resumen.");
        await db.end();
        return;
    }

    const preview = jobs
        .slice(0, PREVIEW_LIMIT)
        .map(describeJob)
        .join("\n");

    const extra = jobs.length > PREVIEW_LIMIT
        ? `\n\n...y ${jobs.length - PREVIEW_LIMIT} más.`
        : "";

    const body =
        `🌙 Resumen nocturno — Citas en Saludtools\n\n` +
        `Hay ${jobs.length} cita(s) que NO se pudieron sincronizar con Saludtools tras varios intentos. ` +
        `Los pacientes ya creen que están agendadas, así que hay que registrarlas a mano:\n\n` +
        `${preview}${extra}\n\n` +
        `Escribe 6️⃣ en el panel ("Citas con problemas") para ver el detalle completo y reintentarlas una por una.`;

    await sendWhatsAppMessage(process.env.SECRETARY_WHATSAPP_NUMBER, body);
    console.log(`Resumen enviado a secretaría: ${jobs.length} cita(s) fallida(s).`);

    await db.end();
}

main().catch(async (error) => {
    console.error("Error fatal en el resumen nocturno:", error);
    await db.end();
    process.exit(1);
});
