import "dotenv/config";
import { db } from "../db/mysql.js";

// Uso: node scripts/check-job-by-document.mjs <documentNumber>
const documentNumber = process.argv[2];

if (!documentNumber) {
    console.error("Uso: node scripts/check-job-by-document.mjs <documentNumber>");
    process.exit(1);
}

async function main() {
    const [rows] = await db.query(
        `SELECT id, job_type, status, phone, appointment_id, payload, attempts, last_error, created_at, updated_at
         FROM saludtools_jobs
         WHERE payload LIKE ?
         ORDER BY created_at DESC
         LIMIT 10`,
        [`%${documentNumber}%`],
    );

    if (!rows.length) {
        console.log(`❌ No hay ningún job en saludtools_jobs que mencione el documento ${documentNumber}.`);
        process.exit(0);
    }

    console.log(`✅ ${rows.length} job(s) encontrados:\n`);
    rows.forEach((row) => {
        console.log(`ID: ${row.id} | Tipo: ${row.job_type} | Estado: ${row.status} | Intentos: ${row.attempts}`);
        console.log(`  Tel: ${row.phone} | Appointment ID local: ${row.appointment_id}`);
        console.log(`  Creado: ${row.created_at} | Actualizado: ${row.updated_at}`);
        if (row.last_error) console.log(`  ❌ Último error: ${row.last_error}`);
        console.log(`  Payload: ${row.payload}\n`);
    });

    process.exit(0);
}

main().catch((e) => {
    console.error("Error:", e.message);
    process.exit(1);
});
