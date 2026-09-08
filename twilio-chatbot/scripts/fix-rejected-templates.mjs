import "dotenv/config";
import twilio from "twilio";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu;

function sanitizeButtonTitle(title) {
    return title.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
}

function extractVariableNumbers(text) {
    const matches = [...String(text || "").matchAll(/\{\{(\d+)\}\}/g)];
    return matches.map((m) => m[1]);
}

function buildExampleVariables(types) {
    const numbers = new Set();
    for (const typeDef of Object.values(types)) {
        extractVariableNumbers(typeDef.body).forEach((n) => numbers.add(n));
        for (const item of typeDef.items || []) {
            extractVariableNumbers(item.title).forEach((n) => numbers.add(n));
            extractVariableNumbers(item.description).forEach((n) => numbers.add(n));
        }
    }
    const variables = {};
    for (const n of numbers) variables[n] = `Ejemplo ${n}`;
    return variables;
}

function sanitizeTypes(types) {
    const cleaned = JSON.parse(JSON.stringify(types));
    for (const typeDef of Object.values(cleaned)) {
        if (Array.isArray(typeDef.actions)) {
            typeDef.actions = typeDef.actions.map((a) => ({
                ...a,
                title: sanitizeButtonTitle(a.title),
            }));
        }
    }
    return cleaned;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const REJECTED_OLD_SIDS = [
    "HXb82d4efe6c8e953e769007d97e1b7683", // confirmar_datos - missing example
    "HX99f2473708d3a747691d12c7844376a6", // recomendacion_1 - missing example
    "HX95ea998332a873f75d2b983698e71c4a", // recomendacion_2 - missing example
    "HX410801da590ca6d399a74197ef34bda0", // citas_lista_1 - missing example
    "HXc2e53d2dacfe6c92c4a72b8e4b91e1e0", // citas_lista_2 - missing example
    "HX61eb5556717309bd3b6d6b0eb78a76e0", // confirmar_accion - missing example
    "HX2c7ba0ad6b58366a172c0cfb11098e0f", // genero - emoji en botones
    "HX606fb740ee66367afa3c387aa8c35e14", // habeas_data - emoji en botones
    "HXf424f63c3ee61d734604063ecc214b10", // solicitud_registrada - emoji en botones + missing example
];

async function fixOne(oldSid) {
    const original = await client.content.v1.contents(oldSid).fetch();

    let category = "UTILITY";
    try {
        const approval = await client.content.v1.contents(oldSid).approvalFetch().fetch();
        category = approval?.whatsapp?.category || "UTILITY";
    } catch {}

    const cleanedTypes = sanitizeTypes(original.types);
    const variables = buildExampleVariables(cleanedTypes);
    const newFriendlyName = `${original.friendlyName}_v3`;

    const created = await client.content.v1.contents.create({
        friendly_name: newFriendlyName,
        language: original.language,
        variables,
        types: cleanedTypes,
    });

    const approvalResult = await client.content.v1
        .contents(created.sid)
        .approvalCreate.create({ name: newFriendlyName, category });

    return {
        oldSid,
        newSid: created.sid,
        friendlyName: newFriendlyName,
        variablesUsed: variables,
        approvalStatus: approvalResult.status,
    };
}

async function main() {
    const results = [];
    for (let i = 0; i < REJECTED_OLD_SIDS.length; i += 1) {
        const oldSid = REJECTED_OLD_SIDS[i];
        try {
            const result = await fixOne(oldSid);
            results.push(result);
            console.log(
                `[${i + 1}/${REJECTED_OLD_SIDS.length}] ${oldSid} -> ${result.newSid} | ${result.friendlyName} | vars=${JSON.stringify(result.variablesUsed)} | ${result.approvalStatus}`,
            );
        } catch (error) {
            results.push({ oldSid, error: error.message });
            console.log(`[${i + 1}/${REJECTED_OLD_SIDS.length}] ${oldSid} -> ERROR: ${error.message}`);
        }
        if (i < REJECTED_OLD_SIDS.length - 1) await sleep(1500);
    }

    console.log("\n=== MAPEO (v3) ===");
    console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
    console.error("Error fatal:", error);
    process.exit(1);
});
