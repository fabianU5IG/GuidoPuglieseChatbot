import test from "node:test";
import assert from "node:assert/strict";

process.env.TWILIO_ACCOUNT_SID ||= "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ||= "test_auth_token";
process.env.TWILIO_WHATSAPP_NUMBER ||= "+573114811385";
process.env.SECRETARY_WHATSAPP_NUMBER ||= "+573224811542";

const TELECONSULTA_SID = "HXdcf56e75504920c35e7e46f4f6c6753b";

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

test("el botón de agendar notifica a la secretaría (commit 612ff2b, 13-ago)", async () => {
    // Desde el 13 de agosto, "Agendar teleconsulta" ya no abre el flujo de IA:
    // notifica a la secretaría y vuelve al menú. Ver states/teleconsulta.state.js.
    const result = await teleconsultaState("teleconsulta_agendar", {}, {});

    assert.equal(result.nextState, "MENU");
    assert.equal(result.data.renderMenu, true);
    assert.match(result.response, /secretaria/i);
});

test("el botón de requisitos permanece dentro del flujo", async () => {
    const result = await teleconsultaState("teleconsulta_requisitos", {}, {});

    assert.equal(result.nextState, "TELECONSULTA");
    assert.equal(result.sendTemplate, true);
    assert.match(result.template.contentSid, /^HX/);
});
