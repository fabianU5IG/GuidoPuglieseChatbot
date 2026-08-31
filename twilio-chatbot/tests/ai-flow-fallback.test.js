import test from "node:test";
import assert from "node:assert/strict";

process.env.TWILIO_ACCOUNT_SID ||= "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ||= "test_auth_token";
process.env.TWILIO_WHATSAPP_NUMBER ||= "+573114811385";
process.env.SECRETARY_WHATSAPP_NUMBER ||= "+573203269984";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test_service_role_key";

// A propósito no se configuran AZURE_OPENAI_* aquí: estos tests verifican que,
// sin IA disponible, `resolveFlowFallback` siempre degrada a `null` y cada
// estado se comporta exactamente igual que antes de agregar el fallback de IA.
delete process.env.AZURE_OPENAI_ENDPOINT;
delete process.env.AZURE_OPENAI_API_KEY;
delete process.env.AZURE_OPENAI_DEPLOYMENT;

const { default: menuState } = await import("../states/menu.state.js");
const { default: gestionCitasState } = await import(
    "../states/gestionCitas.state.js"
);
const { default: teleconsultaState } = await import(
    "../states/teleconsulta.state.js"
);
const { default: infoCostosState } = await import(
    "../states/infoCostos.state.js"
);
const { default: postSurgeryState } = await import(
    "../states/postSurgery.state.js"
);
const { default: soporteCitaState } = await import(
    "../states/soporteCita.state.js"
);
const { default: agendarState } = await import("../states/agendar.state.js");

const GIBBERISH = "xzqwplkjasdf";
const CTX = { from: "+573001112233" };

test("menu: mensaje no reconocido sigue mostrando el menú principal (sin IA configurada)", async () => {
    const result = await menuState(GIBBERISH, {}, CTX);

    assert.equal(result.nextState, "MENU");
    assert.equal(result.sendTemplate, true);
    assert.match(result.template.contentSid, /^HX/);
});

test("gestión de citas: mensaje no reconocido sigue mostrando su propio submenú", async () => {
    const result = await gestionCitasState(GIBBERISH, { rendered: true }, CTX);

    assert.equal(result.nextState, "GESTION_CITAS");
    assert.equal(result.sendTemplate, true);
    assert.match(result.template.contentSid, /^HX/);
});

test("teleconsulta: mensaje no reconocido repite su propia plantilla", async () => {
    const result = await teleconsultaState(GIBBERISH, {}, CTX);

    assert.equal(result.nextState, "TELECONSULTA");
    assert.equal(result.sendTemplate, true);
    assert.match(result.template.contentSid, /^HX/);
});

test("información y costos: mensaje no reconocido repite su propia plantilla", async () => {
    const result = await infoCostosState(GIBBERISH, {}, CTX);

    assert.equal(result.nextState, "INFO_COSTOS");
    assert.equal(result.data.origin, "INFO_COSTOS");
    assert.equal(result.sendTemplate, true);
    assert.match(result.template.contentSid, /^HX/);
});

test("post cirugía: mensaje no reconocido repite la pregunta de días desde la cirugía", async () => {
    const result = await postSurgeryState(GIBBERISH, {}, CTX);

    assert.equal(result.nextState, "POST_SURGERY");
    assert.equal(result.data.step, "ASK_POST_SURGERY_DAYS");
    assert.equal(result.sendTemplate, true);
});

test("soporte de cita: paso desconocido/corrupto vuelve al menú principal", async () => {
    const result = await soporteCitaState(
        GIBBERISH,
        { step: "GARBAGE_STEP", tipo: "REAGENDAR" },
        CTX,
    );

    assert.equal(result.nextState, "MENU");
    assert.equal(result.sendTemplate, true);
    assert.match(result.template.contentSid, /^HX/);
});

test("agendar: paso desconocido/corrupto reinicia el registro en ASK_NAME", async () => {
    const result = await agendarState(
        GIBBERISH,
        { step: "GARBAGE_STEP_XYZ" },
        CTX,
    );

    assert.equal(result.nextState, "AGENDAR");
    assert.equal(result.data.step, "ASK_NAME");
    assert.match(result.response, /nombre completo/i);
});
