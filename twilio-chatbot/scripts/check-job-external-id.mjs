import "dotenv/config";
import { db } from "../db/mysql.js";

const jobId = process.argv[2];

if (!jobId) {
    console.error("Uso: node scripts/check-job-external-id.mjs <jobId>");
    process.exit(1);
}

async function main() {
    const [rows] = await db.query(
        "SELECT id, job_type, status, external_id, appointment_id FROM saludtools_jobs WHERE id = ?",
        [jobId],
    );
    console.log(rows);
    process.exit(0);
}

main().catch((e) => {
    console.error("Error:", e.message);
    process.exit(1);
});
