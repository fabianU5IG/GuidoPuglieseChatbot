// Reintento silencioso, cada hora, de las citas que quedaron en FAILED en
// saludtools_jobs. No espera a nada ni avisa a nadie -- solo las reencola y
// deja que el worker (que ya corre 24/7 en pm2) las procese con su propio
// ritmo. Es el complemento del resumen nocturno (nightly-failed-jobs-digest.mjs):
// ese sí espera, revisa y avisa a secretaría una vez por noche; este solo
// evita que una cita fallida a media tarde se quede muerta hasta las 9pm si
// Saludtools se recupera antes.
//
// Uso (pensado para cron, una vez por hora):
//   node scripts/hourly-retry-failed-jobs.mjs

import "dotenv/config";
import { db } from "../db/mysql.js";
import { getRecentFailedSaludtoolsJobs } from "../services/saludtools-jobs.service.js";

async function requeue(jobId) {
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
        console.log("Sin citas fallidas pendientes, nada para reencolar.");
        await db.end();
        return;
    }

    for (const job of failedJobs) {
        await requeue(job.id);
    }

    console.log(`Reencoladas ${failedJobs.length} cita(s) fallida(s) para reintento silencioso.`);
    await db.end();
}

main().catch(async (error) => {
    console.error("Error fatal en el reintento silencioso:", error);
    await db.end();
    process.exit(1);
});
