import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.TWILIO_ACCOUNT_SID ||= "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ||= "test_auth_token";
process.env.TWILIO_WHATSAPP_NUMBER ||= "+573114811385";
process.env.SECRETARY_WHATSAPP_NUMBER ||= "+573224811542";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test_service_role_key";

const { default: menuState } = await import("../states/menu.state.js");
const { default: agendarState } = await import("../states/agendar.state.js");
const { default: dashboardState } = await import("../states/dashboard.state.js");

test("el botón postoperatorio del menú entra al flujo correcto", async () => {
    for (const payload of [
        "menu_postoperatorio",
        "menu_posoperatorio",
        "postoperatorio_no",
        "Soy paciente postoperatorio",
    ]) {
        const result = await menuState(payload, {}, {});
        assert.equal(result.nextState, "POST_SURGERY", payload);
        assert.equal(result.data.step, "ASK_POST_SURGERY_DAYS", payload);
    }
});

test("una sesión antigua que responde No al filtro de columna continúa", async () => {
    const result = await agendarState(
        "No",
        {
            step: "FILTRO_COLUMNA",
            consultationMode: "PRESENCIAL",
            aiSchedulingEnabled: true,
        },
        { from: "+573001112233" },
    );

    assert.equal(result.nextState, "AGENDAR");
    assert.equal(result.data.step, "ASK_DATE");
    assert.match(result.response, /fecha/i);
    assert.doesNotMatch(result.response, /especializa|columna/i);
});

test("gestión de citas no muestra restricciones de columna o pediatría", async () => {
    const result = await menuState("1", {}, {});

    assert.equal(result.nextState, "GESTION_CITAS");
    assert.equal(result.sendTemplate, undefined);
    assert.doesNotMatch(result.response, /columna|pedi[aá]tric/i);
    assert.match(result.response, /Agendar nueva consulta/i);
});

test("las citas rápidas se guardan localmente y no se encolan a SaludTools", async () => {
    const result = await dashboardState(
        "presencial 15/09 08:30 cc 123456789",
        { step: "QUICK_BULK_MESSAGE" },
        { from: "+573153573132" },
    );

    assert.equal(result.nextState, "DASHBOARD");
    assert.match(result.response, /Guardadas en la base de datos/i);
    assert.match(result.response, /Citas registradas localmente/i);
    assert.doesNotMatch(result.response, /Encoladas para SaludTools/i);
});

test("el bloque de cita rápida no crea jobs APPOINTMENT_CREATE", async () => {
    const source = await readFile(
        new URL("../states/dashboard.state.js", import.meta.url),
        "utf8",
    );
    const quickStart = source.indexOf('case "QUICK_BULK_MESSAGE"');
    const quickEnd = source.indexOf('case "INBOX"', quickStart);
    const quickBlock = source.slice(quickStart, quickEnd);

    assert.match(quickBlock, /createSecretaryQuickAppointment/);
    assert.doesNotMatch(quickBlock, /jobType:\s*"APPOINTMENT_CREATE"/);
});
