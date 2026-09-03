// Reintenta SOLO los pacientes que tienen cita en saludtools_appointments
// pero que no quedaron guardados en saludtools_patients (los que fallaron
// en la última corrida de import-saludtools-bulk.mjs). No vuelve a
// paginar las 968 citas -- las lee directo de la base de datos local, así
// que corre en segundos en vez de una hora.
//
// Uso: node scripts/retry-missing-patients.mjs

import "dotenv/config";
import { db } from "../db/mysql.js";
import { readPatientInSaludtools } from "../services/saludtools-api.service.js";
import { syncSaludtoolsPatient } from "../services/saludtools-sync.service.js";

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const [missing] = await db.query(`
        SELECT DISTINCT a.patient_document_type, a.patient_document_number
        FROM saludtools_appointments a
        LEFT JOIN saludtools_patients p
            ON p.document_type = a.patient_document_type
           AND p.document_number = a.patient_document_number
        WHERE p.id IS NULL
          AND a.patient_document_number IS NOT NULL
    `);

    console.log(`Pacientes con cita pero sin registro guardado: ${missing.length}`);

    if (!missing.length) {
        console.log("No hay nada pendiente.");
        await db.end();
        return;
    }

    for (const row of missing) {
        console.log(
            `\nDocumento ${row.patient_document_number} (tipo ${row.patient_document_type}):`,
        );
        try {
            const resp = await readPatientInSaludtools(
                row.patient_document_type,
                row.patient_document_number,
            );
            console.log("  Respuesta cruda:", JSON.stringify(resp?.body || resp));

            const patientBody = resp?.body?.content?.[0] || resp?.body || resp;

            if (patientBody && (patientBody.id || patientBody.documentNumber)) {
                const ok = await syncSaludtoolsPatient("BULK_IMPORT_RETRY", {
                    ...patientBody,
                    documentType: patientBody.documentType ?? row.patient_document_type,
                    documentNumber: patientBody.documentNumber ?? row.patient_document_number,
                });
                console.log(ok ? "  -> Guardado correctamente." : "  -> No se pudo guardar.");
            } else {
                console.log("  -> Saludtools no devolvió datos de este paciente (puede no existir ahí).");
            }
        } catch (error) {
            console.log("  -> ERROR:", error?.status || error?.businessCode, error?.message, JSON.stringify(error?.response));
        }

        await sleep(4000);
    }

    await db.end();
}

main().catch(async (error) => {
    console.error("Error fatal:", error);
    await db.end();
    process.exit(1);
});
