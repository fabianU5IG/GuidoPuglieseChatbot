// Importación masiva única de citas y pacientes reales de Saludtools hacia
// la copia local (saludtools_appointments / saludtools_patients).
//
// Contexto: el buscador de Saludtools filtrado por doctor+rango de fechas
// devuelve vacío incluso cuando existen citas reales ese día (confirmado en
// vivo). Sin filtros, sí devuelve resultados reales y paginados -- por eso
// este script trae TODO (de toda la clínica, no solo del Dr. Guido),
// descarta lo que no sea del Dr. Guido, y solo entonces pide el detalle de
// esos pacientes puntuales (no los ~10.000 pacientes de toda la clínica).
//
// Uso (en el VPS, dentro de twilio-chatbot/):
//   node scripts/import-saludtools-bulk.mjs
//
// Es seguro re-ejecutarlo (y RE-INTENTAR si se corta a mitad): usa el mismo
// ON DUPLICATE KEY UPDATE que ya usan los webhooks/reconciliación, y cada
// cita se guarda en el momento en que se trae (no al final), así que
// interrumpirlo no pierde lo ya importado.

import "dotenv/config";
import { db } from "../db/mysql.js";
import { saludtoolsEvent, readPatientInSaludtools } from "../services/saludtools-api.service.js";
import {
    syncSaludtoolsAppointment,
    syncSaludtoolsPatient,
} from "../services/saludtools-sync.service.js";

const DOCTOR_DOCUMENT_NUMBER =
    process.env.SALUDTOOLS_DOCTOR_DOCUMENT_NUMBER || "72134079";

// Saludtools nos dio 429 incluso con ~3.5s entre llamadas -- el servicio de
// límite de tasa que ya existía en el proyecto (saludtools-rate-limit.service.js)
// nunca se conectó a ninguna llamada real, así que en la práctica nunca hubo
// espaciado real entre peticiones. Se sube el intervalo base y se agrega
// reintento con espera larga ante un 429, en vez de abortar todo el script.
const DELAY_MS = 8000;
const RETRY_429_WAIT_MS = 75000;
const MAX_RETRIES_PER_CALL = 3;

// Saludtools rechaza con 412 cualquier tamaño de página >= 20
// ("La cantidad maxima de elementos a consultar debe ser menor a 20").
const PAGE_SIZE = 19;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWithRetry(fn, label) {
    for (let attempt = 1; attempt <= MAX_RETRIES_PER_CALL; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            if (error?.status === 429 && attempt < MAX_RETRIES_PER_CALL) {
                console.log(
                    `  [429] ${label}: esperando ${RETRY_429_WAIT_MS / 1000}s antes de reintentar (intento ${attempt}/${MAX_RETRIES_PER_CALL})...`,
                );
                await sleep(RETRY_429_WAIT_MS);
                continue;
            }
            throw error;
        }
    }
}

async function main() {
    console.log("=== 1/2: Trayendo TODAS las citas (paginado, sin filtros) y guardando las del Dr. Guido ===");

    let page = 0;
    let totalPages = 1;
    let totalMatched = 0;
    let totalSaved = 0;
    const uniquePatients = new Map();

    while (page < totalPages) {
        const resp = await callWithRetry(
            () =>
                saludtoolsEvent({
                    eventType: "APPOINTMENT",
                    actionType: "SEARCH",
                    body: { pageable: { page, size: PAGE_SIZE } },
                }),
            `página de citas ${page + 1}`,
        );

        const content = resp?.body?.content || [];
        totalPages = resp?.body?.totalPages ?? totalPages;

        const matchedThisPage = content.filter(
            (item) => String(item?.doctorDocumentNumber) === String(DOCTOR_DOCUMENT_NUMBER),
        );

        for (const appt of matchedThisPage) {
            const ok = await syncSaludtoolsAppointment("BULK_IMPORT", appt);
            if (ok) totalSaved += 1;

            const key = `${appt.patientDocumentType}:${appt.patientDocumentNumber}`;
            if (!uniquePatients.has(key)) {
                uniquePatients.set(key, {
                    documentType: appt.patientDocumentType,
                    documentNumber: appt.patientDocumentNumber,
                });
            }
        }

        totalMatched += matchedThisPage.length;
        console.log(
            `[citas] página ${page + 1}/${totalPages} — ${content.length} filas, ${matchedThisPage.length} del Dr. Guido (${totalMatched} acumuladas, ${totalSaved} guardadas)`,
        );

        page += 1;
        if (page < totalPages) await sleep(DELAY_MS);
    }

    console.log(`\nTotal de citas del Dr. Guido guardadas: ${totalSaved}/${totalMatched}`);
    console.log(`Pacientes únicos a traer: ${uniquePatients.size}\n`);

    console.log("=== 2/2: Trayendo el detalle de cada paciente único ===");

    let savedPatients = 0;
    let failedPatients = 0;
    let i = 0;
    for (const { documentType, documentNumber } of uniquePatients.values()) {
        i += 1;
        try {
            const resp = await callWithRetry(
                () => readPatientInSaludtools(documentType, documentNumber),
                `paciente doc ${documentNumber}`,
            );
            const patientBody = resp?.body?.content?.[0] || resp?.body || resp;

            if (patientBody && (patientBody.id || patientBody.documentNumber)) {
                const ok = await syncSaludtoolsPatient("BULK_IMPORT", {
                    ...patientBody,
                    documentType: patientBody.documentType ?? documentType,
                    documentNumber: patientBody.documentNumber ?? documentNumber,
                });
                if (ok) savedPatients += 1;
            } else {
                failedPatients += 1;
                console.log(`  (${i}/${uniquePatients.size}) sin datos para doc ${documentNumber}`);
            }
        } catch (error) {
            failedPatients += 1;
            console.log(
                `  (${i}/${uniquePatients.size}) error trayendo doc ${documentNumber}:`,
                error?.message || error,
            );
        }

        if (i % 10 === 0 || i === uniquePatients.size) {
            console.log(`  ... progreso pacientes: ${i}/${uniquePatients.size}`);
        }

        if (i < uniquePatients.size) await sleep(DELAY_MS);
    }

    console.log("\n=== RESUMEN ===");
    console.log(`Citas del Dr. Guido guardadas: ${totalSaved}/${totalMatched}`);
    console.log(`Pacientes guardados: ${savedPatients}/${uniquePatients.size}`);
    console.log(`Pacientes con error: ${failedPatients}`);

    await db.end();
}

main().catch(async (error) => {
    console.error("Error fatal en la importación:", error);
    await db.end();
    process.exit(1);
});
