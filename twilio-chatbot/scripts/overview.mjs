// Vista general del estado del chatbot en un solo comando: procesos pm2,
// citas de hoy, jobs de Saludtools pendientes/fallidos, y registros
// abandonados -- en vez de tener que pedir 3-4 consultas sueltas cada vez
// que alguien quiere saber "¿cómo viene todo?".
//
// Uso:
//   node scripts/overview.mjs

import "dotenv/config";
import { execSync } from "node:child_process";
import { db } from "../db/mysql.js";

function section(title) {
    console.log(`\n=== ${title} ===`);
}

function getPm2Status() {
    try {
        const raw = execSync("pm2 jlist", { encoding: "utf8" });
        const procs = JSON.parse(raw);
        return procs.map((p) => ({
            name: p.name,
            status: p.pm2_env?.status,
            uptimeMs: Date.now() - (p.pm2_env?.pm_uptime || Date.now()),
            restarts: p.pm2_env?.restart_time,
        }));
    } catch (error) {
        return null;
    }
}

function formatUptime(ms) {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

async function main() {
    section("Procesos (pm2)");
    const procs = getPm2Status();
    if (!procs) {
        console.log("No se pudo leer el estado de pm2.");
    } else {
        for (const p of procs) {
            console.log(
                `${p.name}: ${p.status} | uptime ${formatUptime(p.uptimeMs)} | reinicios ${p.restarts}`,
            );
        }
    }

    section("Citas de hoy");
    const [todayAppointments] = await db.query(
        `SELECT status, COUNT(*) as total
         FROM appointments
         WHERE created_at >= CURDATE()
         GROUP BY status`,
    );
    if (!todayAppointments.length) {
        console.log("Sin citas creadas hoy todavía.");
    } else {
        for (const row of todayAppointments) {
            console.log(`${row.status}: ${row.total}`);
        }
    }

    section("Jobs de Saludtools (no terminados)");
    const [openJobs] = await db.query(
        `SELECT status, COUNT(*) as total
         FROM saludtools_jobs
         WHERE status NOT IN ('DONE', 'DISMISSED')
         GROUP BY status`,
    );
    if (!openJobs.length) {
        console.log("Todo al día, sin jobs pendientes ni fallidos.");
    } else {
        for (const row of openJobs) {
            console.log(`${row.status}: ${row.total}`);
        }
    }

    section("Registros abandonados (PROPOSED hace más de 1h)");
    const [abandoned] = await db.query(
        `SELECT p.full_name, p.phone, a.scheduled_date, a.scheduled_time, a.created_at
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.status = 'PROPOSED'
           AND a.created_at <= DATE_SUB(NOW(), INTERVAL 60 MINUTE)
         ORDER BY a.created_at ASC`,
    );
    if (!abandoned.length) {
        console.log("Ninguno.");
    } else {
        for (const row of abandoned) {
            console.log(
                `• ${row.full_name} — ${row.phone} — cita ${row.scheduled_date} ${row.scheduled_time} (iniciado ${row.created_at})`,
            );
        }
    }

    console.log();
    await db.end();
}

main().catch(async (error) => {
    console.error("Error armando la vista general:", error);
    await db.end();
    process.exit(1);
});
