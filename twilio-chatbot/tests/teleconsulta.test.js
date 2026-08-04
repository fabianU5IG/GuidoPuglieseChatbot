import test from "node:test";
import assert from "node:assert/strict";

process.env.TWILIO_ACCOUNT_SID ||= "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ||= "test_auth_token";
process.env.TWILIO_WHATSAPP_NUMBER ||= "+573114811385";
process.env.SECRETARY_WHATSAPP_NUMBER ||= "+573224811542";

const TELECONSULTA_SID = "HX18e7c4eb9b23f2fbb53b37f1c2520bed";

const { default: menuState } = await import("../states/menu.state.js");
const { default: teleconsultaState } = await import(
    "../states/teleconsulta.state.js"
);

test("el menú principal envía la plantilla nueva de teleconsulta", async () => {
    const result = await menuState("menu_teleconsulta", {}, {});

    assert.equal(result.sendTemplate, true);
    assert.equal(result.template.contentSid, TELECONSULTA_SID);
    assert.equal(result.nextState, "TELECONSULTA");
});

test("el estado de teleconsulta vuelve a mostrar su plantilla", async () => {
    const result = await teleconsultaState("", {}, {});

    assert.equal(result.sendTemplate, true);
    assert.equal(result.template.contentSid, TELECONSULTA_SID);
    assert.equal(result.nextState, "TELECONSULTA");
});

test("el botón de agendar conserva el origen teleconsulta", async () => {
    const result = await teleconsultaState("teleconsulta_agendar", {}, {});

    assert.equal(result.nextState, "AGENDAR");
    assert.equal(result.data.step, "ASK_NAME");
    assert.equal(result.data.origin, "TELECONSULTA");
    assert.equal(result.data.consultationMode, "TELECONSULTA");
});

test("el botón de requisitos permanece dentro del flujo", async () => {
    const result = await teleconsultaState("teleconsulta_requisitos", {}, {});

    assert.equal(result.nextState, "TELECONSULTA");
    assert.match(result.response, /estudios/i);
    assert.match(result.response, /conexión/i);
});
