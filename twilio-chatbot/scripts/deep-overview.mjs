// Reporte mas profundo que overview.mjs: en vez de solo "hoy", mira todo
// desde una fecha de inicio (por defecto el 1 de octubre) para responder la
// pregunta de fondo que preocupa a secretaria: "¿se está perdiendo gente que
// cree que agendó pero nunca quedó registrado?"
//
// Uso:
//   node scripts/deep-overview.mjs [YYYY-MM-DD]
//   (si no se pasa fecha, usa el 1 de octubre del año actual)

import "dotenv/config";
import { db } from "../db/mysql.js";

const sinceArg = process.argv[2];
const since = sinceArg || `${new Date().getFullYear()}-10-01`;

function section(title) {
    console.log(`\n=== ${title} ===`);
}

async function main() {
    console.log(`Reporte desde ${since} hasta hoy`);

    section("Citas creadas por estado final");
    const [byStatus] = await db.query(
        `SELECT status, COUNT(*) as total
         FROM appointments
         WHERE created_at >= ?
         GROUP BY status
         ORDER BY total DESC`,
        [since],
    );
    let totalAppointments = 0;
    for (const row of byStatus) {
        totalAppointments += row.total;
        console.log(`${row.status}: ${row.total}`);
    }
    console.log(`TOTAL: ${totalAppointments}`);

    section("Citas creadas por semana (CONFIRMED vs el resto)");
    const [byWeek] = await db.query(
        `SELECT
            YEARWEEK(created_at, 3) as semana,
            MIN(DATE(created_at)) as desde,
            SUM(status = 'CONFIRMED') as confirmadas,
            SUM(status != 'CONFIRMED') as no_confirmadas,
            COUNT(*) as total
         FROM appointments
         WHERE created_at >= ?
         GROUP BY semana
         ORDER BY semana ASC`,
        [since],
    );
    for (const row of byWeek) {
        console.log(
            `Semana de ${row.desde}: ${row.total} total — ${row.confirmadas} confirmadas, ${row.no_confirmadas} sin confirmar`,
        );
    }

    section("Jobs de Saludtools por estado (desde la fecha)");
    const [jobsByStatus] = await db.query(
        `SELECT status, COUNT(*) as total
         FROM saludtools_jobs
         WHERE created_at >= ?
         GROUP BY status
         ORDER BY total DESC`,
        [since],
    );
    for (const row of jobsByStatus) {
        console.log(`${row.status}: ${row.total}`);
    }

    section("TODAS las citas que NO quedaron confirmadas (de cualquier fecha, abiertas ahora)");
    const [unresolved] = await db.query(
        `SELECT a.id, p.full_name, p.phone, a.scheduled_date, a.scheduled_time, a.status, a.created_at
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.created_at >= ?
           AND a.status NOT IN ('CONFIRMED', 'CANCELLED')
         ORDER BY a.created_at ASC`,
        [since],
    );
    if (!unresolved.length) {
        console.log("Ninguna -- todo lo creado desde esa fecha terminó CONFIRMED o CANCELLED.");
    } else {
        for (const row of unresolved) {
            console.log(
                `• [#${row.id}] ${row.full_name} — ${row.phone} — cita ${row.scheduled_date} ${row.scheduled_time} — estado: ${row.status} (creado ${row.created_at})`,
            );
        }
    }

    section("Jobs de Saludtools que fallaron de verdad (status FAILED ahora mismo)");
    const [failedNow] = await db.query(
        `SELECT id, phone, payload, last_error, created_at
         FROM saludtools_jobs
         WHERE status = 'FAILED' AND created_at >= ?
         ORDER BY created_at ASC`,
        [since],
    );
    if (!failedNow.length) {
        console.log("Ninguno -- nada quedó fallido sin resolver.");
    } else {
        for (const row of failedNow) {
            const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
            console.log(
                `• [job ${row.id}] ${payload?.fullName || "?"} — ${row.phone} — error: ${row.last_error} (creado ${row.created_at})`,
            );
        }
    }

    console.log();
    await db.end();
}

main().catch(async (error) => {
    console.error("Error armando el reporte profundo:", error);
    await db.end();
    process.exit(1);
});
