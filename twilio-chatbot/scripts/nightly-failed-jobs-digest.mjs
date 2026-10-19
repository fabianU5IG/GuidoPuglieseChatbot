// Resumen nocturno para secretaría con dos cosas que necesitan que alguien
// intervenga a mano:
//
// 1. Citas que quedaron en FAILED en saludtools_jobs (agotaron todos sus
//    reintentos sin lograr sincronizar con Saludtools). El paciente de cada
//    una ya cree que su cita está agendada (ver optimisticPatientConfirm en
//    agendar.state.js), así que antes de molestar a secretaría les damos una
//    última oportunidad: se reencolan, se espera a que el worker (que ya
//    corre 24/7 en pm2) las reprocese, y SOLO entonces se revisa cuáles
//    siguen sin resolverse -- muchas veces Saludtools se recupera sola entre
//    que fallaron y la noche.
//
// 2. Registros que el paciente dejó a medias (nunca llegaron a confirmar,
//    status PROPOSED). Se muestran todos, marcando con una advertencia los
//    que quedaron con el identificador raro de Twilio (CO.xxx/QD-xxx) en vez
//    de un teléfono real -- secretaría decide si igual quiere intentar algo
//    (reconocer el nombre, etc.), pero sabe de entrada que no puede llamarlos.
//
// Uso (pensado para cron, una vez por noche):
//   node scripts/nightly-failed-jobs-digest.mjs

import "dotenv/config";
import { db } from "../db/mysql.js";
import {
    getRecentFailedSaludtoolsJobs,
    getSaludtoolsJobById,
} from "../services/saludtools-jobs.service.js";
import {
    sendWhatsAppMessage,
    formatPatientPhoneForSecretary,
} from "../services/whatsapp.service.js";

const PREVIEW_LIMIT = 10;

// Tiempo que se le da al worker (ya corriendo en background) para reprocesar
// el reencolado antes de revisar qué quedó. No hace falta que alcance para
// agotar los 60 intentos completos -- solo para que Saludtools tenga una
// oportunidad real esta noche, con un par de reintentos si vuelve a dar 429.
const SWEEP_WAIT_MS = 5 * 60_000;

// Un registro recién empezado (el paciente está escribiendo en este mismo
// momento) no es "abandonado" -- se da este margen antes de considerarlo así.
const ABANDONED_AFTER_MINUTES = 60;

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

function describeAbandoned(row) {
    const name = row.full_name || "Paciente sin nombre";
    const phone = formatPatientPhoneForSecretary(row.phone);
    return `• ${name} — 📞 ${phone} — 📅 ${row.scheduled_date} ${row.scheduled_time}`;
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

async function getStillStuckFailedJobs() {
    const failedJobs = await getRecentFailedSaludtoolsJobs(200);

    if (!failedJobs.length) {
        console.log("Sin citas fallidas pendientes para el barrido.");
        return [];
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
            `Las ${failedJobs.length} cita(s) se resolvieron solas en el barrido.`,
        );
    }

    return stillStuck;
}

async function getAbandonedRegistrations() {
    const [rows] = await db.query(
        `
          SELECT a.id, p.full_name, p.phone, a.scheduled_date, a.scheduled_time
          FROM appointments a
          JOIN patients p ON p.id = a.patient_id
          WHERE a.status = 'PROPOSED'
            AND a.created_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
          ORDER BY a.created_at ASC
        `,
        [ABANDONED_AFTER_MINUTES],
    );

    return rows;
}

function buildSection(title, items, describe, actionLine) {
    if (!items.length) return null;

    const preview = items.slice(0, PREVIEW_LIMIT).map(describe).join("\n");
    const extra =
        items.length > PREVIEW_LIMIT
            ? `\n\n...y ${items.length - PREVIEW_LIMIT} más.`
            : "";

    return `${title}\n\n${preview}${extra}\n\n${actionLine}`;
}

async function main() {
    const stillStuck = await getStillStuckFailedJobs();
    const abandoned = await getAbandonedRegistrations();

    const sections = [
        buildSection(
            `⚠️ Hay ${stillStuck.length} cita(s) que NO se pudieron sincronizar con Saludtools, incluso después de reintentarlas de nuevo esta noche. Los pacientes ya creen que están agendadas, así que hay que registrarlas a mano:`,
            stillStuck,
            describeJob,
            `Escribe 6️⃣ en el panel ("Citas con problemas") para ver el detalle completo y reintentarlas una por una.`,
        ),
        buildSection(
            `📵 Hay ${abandoned.length} paciente(s) que empezaron a agendar pero nunca confirmaron:`,
            abandoned,
            describeAbandoned,
            `A los que tienen número real les pueden escribir para preguntar si todavía quieren esa cita. A los demás (marcados con ⚠️) no se les puede llamar, pero quedan acá por si reconocen el nombre.`,
        ),
    ].filter(Boolean);

    if (!sections.length) {
        console.log("Nada pendiente de revisar, no se envía resumen.");
        await db.end();
        return;
    }

    const body = `🌙 Resumen nocturno\n\n${sections.join("\n\n---\n\n")}`;

    await sendWhatsAppMessage(process.env.SECRETARY_WHATSAPP_NUMBER, body);
    console.log(
        `Resumen enviado a secretaría: ${stillStuck.length} cita(s) sin sincronizar, ${abandoned.length} registro(s) abandonado(s) con número real.`,
    );

    await db.end();
}

main().catch(async (error) => {
    console.error("Error fatal en el resumen nocturno:", error);
    await db.end();
    process.exit(1);
});
