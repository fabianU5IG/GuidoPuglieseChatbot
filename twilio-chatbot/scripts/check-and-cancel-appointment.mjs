import "dotenv/config";
import {
    searchAppointmentsByPatientInSaludtools,
    deleteAppointmentInSaludtools,
} from "../services/saludtools-api.service.js";

// Uso:
//   node scripts/check-and-cancel-appointment.mjs <documentNumber> [documentType] [--cancel]
//
// documentType: 1=cc (default), 2=ce, 3=ti
// Sin --cancel solo lista las citas del paciente (modo consulta).
// Con --cancel borra TODAS las citas encontradas para ese documento en Saludtools.

const documentNumber = process.argv[2];
const documentType = Number(process.argv[3] || 1);
const shouldCancel = process.argv.includes("--cancel");

if (!documentNumber) {
    console.error(
        "Uso: node scripts/check-and-cancel-appointment.mjs <documentNumber> [documentType] [--cancel]",
    );
    process.exit(1);
}

async function main() {
    console.log(`\n🔎 Buscando citas para documento ${documentNumber} (tipo ${documentType}) en Saludtools...\n`);

    const result = await searchAppointmentsByPatientInSaludtools({
        patientDocumentType: documentType,
        patientDocumentNumber: documentNumber,
    });

    const appointments = result?.content || result?.data?.content || result || [];
    const list = Array.isArray(appointments) ? appointments : [];

    if (!list.length) {
        console.log("❌ No se encontró ninguna cita para ese documento en Saludtools.");
        return;
    }

    console.log(`✅ Se encontraron ${list.length} cita(s):\n`);
    list.forEach((appt, i) => {
        console.log(
            `${i + 1}. ID: ${appt.id} | Inicio: ${appt.startAppointment} | Fin: ${appt.endAppointment} | Estado: ${appt.stateAppointment} | Modalidad: ${appt.modality}`,
        );
    });

    if (!shouldCancel) {
        console.log("\nℹ️ Modo consulta. Para cancelarlas todas, vuelve a correr con --cancel al final.");
        return;
    }

    console.log("\n🗑️ Cancelando...\n");
    for (const appt of list) {
        try {
            await deleteAppointmentInSaludtools({ id: appt.id });
            console.log(`✅ Cancelada cita ID ${appt.id}`);
        } catch (error) {
            console.log(`❌ Error cancelando cita ID ${appt.id}: ${error.message}`);
        }
    }
}

main().catch((e) => {
    console.error("Error:", e.message);
    process.exit(1);
});
