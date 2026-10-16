// Barrido nocturno de citas que quedaron en FAILED en saludtools_jobs
// (agotaron todos sus reintentos sin lograr sincronizar con Saludtools). El
// paciente de cada una ya cree que su cita está agendada (ver
// optimisticPatientConfirm en agendar.state.js), así que antes de molestar a
// secretaría les damos una última oportunidad: se reencolan, se espera a que
// el worker (que ya corre 24/7 en pm2) las reprocese, y SOLO entonces se
// revisa cuáles siguen sin resolverse para avisar por esas -- muchas veces
// Saludtools se recupera sola entre que fallaron y la noche, y no hace falta
// que nadie intervenga a mano.
//
// Uso (pensado para cron, una vez por noche):
//   node scripts/nightly-failed-jobs-digest.mjs

import "dotenv/config";
import { db } from "../db/mysql.js";
import {
    getRecentFailedSaludtoolsJobs,
    getSaludtoolsJobById,
} from "../services/saludtools-jobs.service.js";
import { sendWhatsAppMessage } from "../services/whatsapp.service.js";

const PREVIEW_LIMIT = 10;

// Tiempo que se le da al worker (ya corriendo en background) para reprocesar
// el reencolado antes de revisar qué quedó. No hace falta que alcance para
// agotar los 60 intentos completos -- solo para que Saludtools tenga una
// oportunidad real esta noche, con un par de reintentos si vuelve a dar 429.
const SWEEP_WAIT_MS = 5 * 60_000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function requeueForSweep(jobId) {
    await db.query(
        `
          UPDATE saludtools_jobs
          SET status = 'PENDING',
              attempts = 0,
              next_run_at = NOW(),
              last_error = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'FAILED'
        `,
        [jobId],
    );
}

async function main() {
    const failedJobs = await getRecentFailedSaludtoolsJobs(200);

    if (!failedJobs.length) {
        console.log("Sin citas fallidas pendientes, no se envía resumen.");
        await db.end();
        return;
    }

    console.log(
        `Reencolando ${failedJobs.length} cita(s) fallida(s) para el barrido nocturno...`,
    );
    for (const job of failedJobs) {
        await requeueForSweep(job.id);
    }

    console.log(
        `Esperando ${SWEEP_WAIT_MS / 1000}s a que el worker las reprocese...`,
    );
    await sleep(SWEEP_WAIT_MS);

    const stillStuck = [];
    for (const job of failedJobs) {
        const current = await getSaludtoolsJobById(job.id);
        if (current && current.status !== "DONE") {
            stillStuck.push(current);
        }
    }

    if (!stillStuck.length) {
        console.log(
            `Las ${failedJobs.length} cita(s) se resolvieron solas en el barrido, no se envía resumen.`,
        );
        await db.end();
        return;
    }

    const preview = stillStuck
        .slice(0, PREVIEW_LIMIT)
        .map(describeJob)
        .join("\n");

    const extra =
        stillStuck.length > PREVIEW_LIMIT
            ? `\n\n...y ${stillStuck.length - PREVIEW_LIMIT} más.`
            : "";

    const body =
        `🌙 Resumen nocturno — Citas en Saludtools\n\n` +
        `Hay ${stillStuck.length} cita(s) que NO se pudieron sincronizar con Saludtools, incluso después de reintentarlas de nuevo esta noche. ` +
        `Los pacientes ya creen que están agendadas, así que hay que registrarlas a mano:\n\n` +
        `${preview}${extra}\n\n` +
        `Escribe 6️⃣ en el panel ("Citas con problemas") para ver el detalle completo y reintentarlas una por una.`;

    await sendWhatsAppMessage(process.env.SECRETARY_WHATSAPP_NUMBER, body);
    console.log(
        `Resumen enviado a secretaría: ${stillStuck.length} de ${failedJobs.length} cita(s) seguían sin resolverse.`,
    );

    await db.end();
}

main().catch(async (error) => {
    console.error("Error fatal en el resumen nocturno:", error);
    await db.end();
    process.exit(1);
});
