// Duplica las Content Templates de Twilio y las manda a re-aprobación de
// WhatsApp bajo la WABA actual del número +573202385999.
//
// Contexto: las plantillas originales están "Approved" a nivel de cuenta de
// Twilio, pero fallan con error 63027 ("Template does not exist for a
// language and locale") al enviarse desde el número nuevo -- la aprobación
// quedó vinculada a la WABA anterior (el número viejo +573114811385 ya se
// eliminó). Duplicar cada plantilla y volver a pedir aprobación genera una
// solicitud nueva contra la WABA activa hoy (2331370467500120), sin
// depender de que Twilio soporte resuelva el vínculo viejo.
//
// Uso: node scripts/duplicate-templates.mjs
//
// NO borra las plantillas viejas -- eso se hace aparte, manualmente, solo
// después de confirmar que las nuevas quedaron aprobadas y funcionando en
// producción con los SID actualizados en el código.

import "dotenv/config";
import twilio from "twilio";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// La del menú principal ya se duplicó y se mandó a aprobación como prueba
// piloto -- se excluye de esta lista para no duplicarla dos veces.
const OLD_SIDS = [
    "HX81850303bf6a4fb7807fe02bf293d497",
    "HX91e5d2cc86e00782a2ca350967eabf43",
    "HX288f8c61244fb7ccd84dadc3a2b18085",
    "HXb82d4efe6c8e953e769007d97e1b7683",
    "HX6870e9d8c2a707250a7b7b6dd3657bba",
    "HXef564c5e031c89c509865f9ad0cc2671",
    "HXf0c0b5145ad2c66b0dc2ee6016edcb08",
    "HXd9b8fa306aa4c104781028d08cb2f5be",
    "HX2c7ba0ad6b58366a172c0cfb11098e0f",
    "HXbb5aca08c0cdb066a18f498bb1008777",
    "HX4b3a4c4c8156d55b10784d96d65a8767",
    "HX2c186ee128f8b00e3e76af2ca8ab19d2",
    "HX606fb740ee66367afa3c387aa8c35e14",
    "HXcc96f44990e9c311650fe93e71b3b1bc",
    "HXf424f63c3ee61d734604063ecc214b10",
    "HX99f2473708d3a747691d12c7844376a6",
    "HX95ea998332a873f75d2b983698e71c4a",
    "HXd07499f9bf2d1fe24f69226be43a4026",
    "HXe1da2f8036073f44fad55c7a72f9e155",
    "HX5256580c02d8a037cbafa7e5a3c1fd55",
    "HXdcf56e75504920c35e7e46f4f6c6753b",
    "HXac4185b56c6a8f99a45e9aabc91b74ff",
    "HX94711af7408f422962cb914731d0bae6",
    "HX3b07c0984e3fc8c6d2f96630752ef101",
    "HX410801da590ca6d399a74197ef34bda0",
    "HXc2e53d2dacfe6c92c4a72b8e4b91e1e0",
    "HX072205031a720753efdab0d041c98f4f",
    "HX61eb5556717309bd3b6d6b0eb78a76e0",
    "HXc09271c38baeaa3ba666f67352280bcc",
    "HX3d6f8d50fc9cbb42d1daf4874de00520",
    "HXb3c1b58fd9b398790b07579f054885e5",
    "HX35cb52ef7fc6c9d1e4a1135bdabbbd4e",
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function duplicateOne(oldSid) {
    const original = await client.content.v1.contents(oldSid).fetch();

    let category = "UTILITY";
    try {
        const approval = await client.content.v1.contents(oldSid).approvalFetch().fetch();
        category = approval?.whatsapp?.category || "UTILITY";
    } catch {
        // Si no se puede leer la categoría original, se asume UTILITY
        // (la más común y menos restrictiva) en vez de fallar todo el lote.
    }

    const newFriendlyName = `${original.friendlyName}_v2`;

    const created = await client.content.v1.contents.create({
        friendly_name: newFriendlyName,
        language: original.language,
        variables: original.variables,
        types: original.types,
    });

    const approvalResult = await client.content.v1
        .contents(created.sid)
        .approvalCreate.create({ name: newFriendlyName, category });

    return {
        oldSid,
        newSid: created.sid,
        friendlyName: newFriendlyName,
        category,
        approvalStatus: approvalResult.status,
        rejectionReason: approvalResult.rejectionReason || null,
    };
}

async function main() {
    const results = [];

    for (let i = 0; i < OLD_SIDS.length; i += 1) {
        const oldSid = OLD_SIDS[i];
        try {
            const result = await duplicateOne(oldSid);
            results.push(result);
            console.log(
                `[${i + 1}/${OLD_SIDS.length}] ${oldSid} -> ${result.newSid} | ${result.friendlyName} | categoria=${result.category} | aprobacion=${result.approvalStatus}`,
            );
        } catch (error) {
            results.push({ oldSid, error: error.message });
            console.log(`[${i + 1}/${OLD_SIDS.length}] ${oldSid} -> ERROR: ${error.message}`);
        }

        if (i < OLD_SIDS.length - 1) await sleep(1500);
    }

    console.log("\n=== MAPEO SID VIEJO -> SID NUEVO (guardar esto) ===");
    console.log(JSON.stringify(results, null, 2));

    const failed = results.filter((r) => r.error);
    console.log(`\nTotal: ${results.length} | OK: ${results.length - failed.length} | Errores: ${failed.length}`);
}

main().catch((error) => {
    console.error("Error fatal:", error);
    process.exit(1);
});
