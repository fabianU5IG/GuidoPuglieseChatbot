import "dotenv/config";
import twilio from "twilio";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cada entrada: SID viejo, categoria, y una funcion que ajusta el body para
// que no empiece/termine en variable y tenga suficiente texto fijo alrededor.
const FIXES = [
    {
        oldSid: "HX99f2473708d3a747691d12c7844376a6",
        name: "agendamiento_recomendacion_1",
        category: "UTILITY",
        adjustBody: (body) => body + "\n\n0️⃣ Volver al menú",
        variables: { "1": "Ejemplo", "2": "Ejemplo", "3": "Ejemplo", "4": "Ejemplo", "5": "Ejemplo" },
    },
    {
        oldSid: "HX95ea998332a873f75d2b983698e71c4a",
        name: "agendamiento_recomendacion_2",
        category: "UTILITY",
        adjustBody: (body) => body + "\n\n0️⃣ Volver al menú",
        variables: { "1": "Ejemplo", "2": "Ejemplo", "3": "Ejemplo", "4": "Ejemplo", "5": "Ejemplo", "6": "Ejemplo", "7": "Ejemplo", "8": "Ejemplo" },
    },
    {
        oldSid: "HX410801da590ca6d399a74197ef34bda0",
        name: "soporte_citas_lista_1",
        category: "UTILITY",
        adjustBody: (body) => body + "\n\n0️⃣ Volver al menú",
        variables: { "1": "Ejemplo", "2": "Ejemplo" },
    },
    {
        oldSid: "HXc2e53d2dacfe6c92c4a72b8e4b91e1e0",
        name: "soporte_citas_lista_2",
        category: "UTILITY",
        adjustBody: (body) => body + "\n\n0️⃣ Volver al menú",
        variables: { "1": "Ejemplo", "2": "Ejemplo", "3": "Ejemplo" },
    },
    {
        oldSid: "HX61eb5556717309bd3b6d6b0eb78a76e0",
        name: "soporte_confirmar_accion",
        category: "UTILITY",
        adjustBody: () =>
            "📋 Resumen de tu solicitud:\n\n{{1}}\n\nPor favor confirma si deseas continuar.",
        variables: { "1": "Ejemplo" },
    },
];

async function fixOne(fix) {
    const original = await client.content.v1.contents(fix.oldSid).fetch();
    const type = Object.keys(original.types)[0];
    const originalTypeDef = original.types[type];

    const newTypeDef = {
        ...originalTypeDef,
        body: fix.adjustBody(originalTypeDef.body),
    };

    const newFriendlyName = `${fix.name}_v4`;

    const created = await client.content.v1.contents.create({
        friendly_name: newFriendlyName,
        language: original.language,
        variables: fix.variables,
        types: { [type]: newTypeDef },
    });

    const approvalResult = await client.content.v1
        .contents(created.sid)
        .approvalCreate.create({ name: newFriendlyName, category: fix.category });

    return { oldSid: fix.oldSid, newSid: created.sid, friendlyName: newFriendlyName, status: approvalResult.status };
}

async function main() {
    const results = [];
    for (let i = 0; i < FIXES.length; i += 1) {
        try {
            const r = await fixOne(FIXES[i]);
            results.push(r);
            console.log(`[${i + 1}/${FIXES.length}] ${r.oldSid} -> ${r.newSid} | ${r.friendlyName} | ${r.status}`);
        } catch (error) {
            results.push({ oldSid: FIXES[i].oldSid, error: error.message });
            console.log(`[${i + 1}/${FIXES.length}] ${FIXES[i].oldSid} -> ERROR: ${error.message}`);
        }
        if (i < FIXES.length - 1) await sleep(1500);
    }
    console.log("\n=== RESULTADO v4 ===");
    console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
