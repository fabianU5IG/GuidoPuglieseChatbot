import "dotenv/config";
import { deleteAppointmentInSaludtools } from "../services/saludtools-api.service.js";

// Uso: node scripts/delete-appointment-by-id.mjs <idSaludtools>
const id = process.argv[2];

if (!id) {
    console.error("Uso: node scripts/delete-appointment-by-id.mjs <idSaludtools>");
    process.exit(1);
}

async function main() {
    const result = await deleteAppointmentInSaludtools({ id });
    console.log("✅ Respuesta de Saludtools:", JSON.stringify(result, null, 2));
}

main().catch((e) => {
    console.error("❌ Error cancelando la cita:", e.message);
    process.exit(1);
});
