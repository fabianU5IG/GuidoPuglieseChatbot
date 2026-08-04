import test from "node:test";
import assert from "node:assert/strict";

process.env.TWILIO_ACCOUNT_SID ||= "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ||= "test_auth_token";
process.env.TWILIO_WHATSAPP_NUMBER ||= "+573114811385";
process.env.SECRETARY_WHATSAPP_NUMBER ||= "+573224811542";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test_service_role_key";

const { default: menuState } = await import("../states/menu.state.js");
const { default: gestionCitasState } = await import(
    "../states/gestionCitas.state.js"
);
const { default: postSurgeryState } = await import(
    "../states/postSurgery.state.js"
);
const { default: infoCostosState } = await import(
    "../states/infoCostos.state.js"
);
const { default: teleconsultaState } = await import(
    "../states/teleconsulta.state.js"
);
const { default: agendarState } = await import("../states/agendar.state.js");

test("el agendamiento principal activa IA global", async () => {
    const result = await menuState("agendar_cita", {}, {});

    assert.equal(result.nextState, "AGENDAR");
    assert.equal(result.data.consultationMode, "PRESENCIAL");
    assert.equal(result.data.aiSchedulingEnabled, true);
    assert.match(result.response, /IA/i);
});

test("gestión de citas inicia agendamiento con IA global", async () => {
    const result = await gestionCitasState("1", { rendered: true }, {});

    assert.equal(result.nextState, "AGENDAR");
    assert.equal(result.data.origin, "CONSULTA_GENERAL");
    assert.equal(result.data.aiSchedulingEnabled, true);
});

test("agendamiento desde información y costos activa IA", async () => {
    const result = await infoCostosState("agendar_consulta", {}, {});

    assert.equal(result.nextState, "AGENDAR");
    assert.equal(result.data.consultationMode, "PRESENCIAL");
    assert.equal(result.data.aiSchedulingEnabled, true);
});

test("cita posoperatoria usa la misma IA global", async () => {
    const result = await postSurgeryState("1", {}, {});

    assert.equal(result.nextState, "AGENDAR");
    assert.equal(result.data.origin, "POSOPERATORIO");
    assert.equal(result.data.aiSchedulingEnabled, true);
    assert.equal(result.data.isPostOperative, true);
});

test("teleconsulta conserva modalidad y comparte IA global", async () => {
    const result = await teleconsultaState("teleconsulta_agendar", {}, {});

    assert.equal(result.nextState, "AGENDAR");
    assert.equal(result.data.consultationMode, "TELECONSULTA");
    assert.equal(result.data.aiSchedulingEnabled, true);
});

test("una preferencia natural activa recomendaciones globales de fecha", async () => {
    const result = await agendarState(
        "la próxima semana en la tarde",
        {
            step: "ASK_DATE",
            consultationMode: "PRESENCIAL",
            aiSchedulingEnabled: true,
        },
        { from: "+573001112233" },
    );

    assert.equal(result.nextState, "AGENDAR");
    assert.match(result.response, /opciones de agenda|opciones más convenientes/i);
    assert.ok(result.data.aiRecommendations.length >= 1);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysUntilNextMonday = ((8 - today.getDay()) % 7) || 7;
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + daysUntilNextMonday);
    const nextSunday = new Date(nextMonday);
    nextSunday.setDate(nextMonday.getDate() + 6);

    for (const option of result.data.aiRecommendations) {
        const optionDate = new Date(`${option.ymd}T00:00:00`);
        assert.ok(optionDate >= nextMonday && optionDate <= nextSunday);
        assert.ok(Number(option.time.slice(0, 2)) >= 12);
    }
});

test("la IA recomienda horarios dentro de una fecha seleccionada", async () => {
    const result = await agendarState(
        "recomiéndame en la mañana",
        {
            step: "ASK_TIME",
            date: "06/08",
            ymd: "2026-08-06",
            consultationMode: "PRESENCIAL",
            aiSchedulingEnabled: true,
        },
        { from: "+573001112233" },
    );

    assert.equal(result.nextState, "AGENDAR");
    assert.match(result.response, /Para el 06\/08/i);
    assert.equal(result.data.aiTimeRecommendationActive, true);
    assert.ok(result.data.aiTimeRecommendations.length >= 1);
    assert.ok(
        result.data.aiTimeRecommendations.every(
            (option) => Number(option.time.slice(0, 2)) < 12,
        ),
    );
});
