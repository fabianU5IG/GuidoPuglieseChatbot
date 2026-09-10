import "dotenv/config";
import twilio from "twilio";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Uso:
//   node scripts/check-messages.mjs                      -> últimos 20 mensajes
//   node scripts/check-messages.mjs +573005376530         -> filtra por numero (from o to)
//   node scripts/check-messages.mjs +573005376530 50      -> limite personalizado
const filterNumber = process.argv[2] || null;
const limit = Number(process.argv[3] || 20);

function normalize(num) {
    if (!num) return null;
    const cleaned = num.replace(/[^\d+]/g, "");
    return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

async function main() {
    const target = normalize(filterNumber);

    const messages = await client.messages.list({ limit: 100 });

    const filtered = target
        ? messages.filter(
              (m) =>
                  (m.to || "").includes(target) ||
                  (m.from || "").includes(target),
          )
        : messages;

    const rows = filtered.slice(0, limit);

    console.log(`\n=== Últimos ${rows.length} mensajes${target ? ` (filtrado por ${target})` : ""} ===\n`);

    for (const m of rows) {
        const fecha = new Date(m.dateSent || m.dateCreated).toLocaleString("es-CO");
        const direccion = m.direction.startsWith("inbound") ? "⬅️ IN " : "➡️ OUT";
        const cuerpo = (m.body || "").replace(/\n/g, " ⏎ ").slice(0, 90);
        const error = m.errorCode ? ` | ❌ ERROR ${m.errorCode}: ${m.errorMessage}` : "";

        console.log(
            `${fecha} | ${direccion} | ${m.from} -> ${m.to} | ${m.status.toUpperCase()}${error}`,
        );
        console.log(`   "${cuerpo}"`);
        console.log(`   SID: ${m.sid}\n`);
    }
}

main().catch((e) => {
    console.error("Error consultando mensajes:", e.message);
    process.exit(1);
});
