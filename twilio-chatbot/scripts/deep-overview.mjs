// Reporte profundo y en lenguaje simple (pensado para pegarle directo a
// secretaria, no tecnica) desde una fecha de inicio (default: 1 de octubre).
// Responde la preocupacion de fondo: "¿se está perdiendo gente que cree que
// agendó pero nunca quedó registrado?" -- mostrando nombre, cédula y fecha
// de cada caso que de verdad necesita revisión, no solo numeros y conteos.
//
// Uso:
//   node scripts/deep-overview.mjs [YYYY-MM-DD]
//   (si no se pasa fecha, usa el 1 de octubre del año actual)

import "dotenv/config";
import { db } from "../db/mysql.js";

const sinceArg = process.argv[2];
const since = sinceArg || `${new Date().getFullYear()}-10-01`;

function parsePayload(raw) {
    if (!raw) return null;
    try {
        return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
}

function formatFecha(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value || "");
    return d.toLocaleDateString("es-CO", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    });
}

async function getDocumentNumberForAppointment(appointmentId) {
    const [rows] = await db.query(
        `SELECT payload FROM saludtools_jobs WHERE appointment_id = ? ORDER BY id DESC LIMIT 1`,
        [appointmentId],
    );
    const payload = parsePayload(rows?.[0]?.payload);
    return (
        payload?.appointmentBody?.patientDocumentNumber ||
        payload?.patientBody?.documentNumber ||
        null
    );
}

async function main() {
    const [byStatus] = await db.query(
        `SELECT status, COUNT(*) as total
         FROM appointments
         WHERE created_at >= ?
         GROUP BY status`,
        [since],
    );

    const totals = Object.fromEntries(byStatus.map((r) => [r.status, r.total]));
    const totalAppointments = byStatus.reduce((acc, r) => acc + r.total, 0);
    const confirmadas = totals.CONFIRMED || 0;
    const canceladas = totals.CANCELLED || 0;
    const sinResolver = totalAppointments - confirmadas - canceladas;

    const [unresolved] = await db.query(
        `SELECT a.id, p.full_name, p.phone, a.scheduled_date, a.scheduled_time, a.status, a.created_at
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.created_at >= ?
           AND a.status NOT IN ('CONFIRMED', 'CANCELLED')
         ORDER BY a.created_at ASC`,
        [since],
    );

    const STATUS_LABEL = {
        PROPOSED: "Empezó a agendar pero nunca confirmó",
        QUEUED: "Se está procesando todavía",
        FAILED: "No se pudo confirmar con Saludtools",
    };

    console.log(`📊 Reporte de citas desde el ${formatFecha(since)}\n`);
    console.log(`Se agendaron ${totalAppointments} citas en total:`);
    console.log(`✅ ${confirmadas} quedaron confirmadas correctamente`);
    console.log(`🚫 ${canceladas} fueron canceladas (por el paciente o la secretaría)`);
    console.log(
        `⚠️ ${sinResolver} necesitan revisión (no se confirmaron ni se cancelaron)\n`,
    );

    if (!unresolved.length) {
        console.log("No hay ningún caso pendiente de revisar. Todo lo demás quedó en orden. ✅");
    } else {
        console.log(`Estos son los ${unresolved.length} caso(s) que hay que revisar:\n`);

        let i = 1;
        for (const row of unresolved) {
            const docNumber = await getDocumentNumberForAppointment(row.id);
            console.log(`${i}. 👤 ${row.full_name || "Paciente sin nombre"}`);
            if (docNumber) console.log(`   📄 Cédula: ${docNumber}`);
            console.log(`   📞 Teléfono: ${row.phone}`);
            console.log(
                `   📅 Fecha de la cita: ${formatFecha(row.scheduled_date)} a las ${row.scheduled_time}`,
            );
            console.log(
                `   📌 Situación: ${STATUS_LABEL[row.status] || row.status}`,
            );
            console.log();
            i += 1;
        }
    }

    await db.end();
}

main().catch(async (error) => {
    console.error("Error armando el reporte profundo:", error);
    await db.end();
    process.exit(1);
});
