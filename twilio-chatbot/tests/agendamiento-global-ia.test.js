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
const { default: chatbotResponse } = await import("../chatbot.js");

// Se calcula en cada corrida (en vez de usar una fecha fija) para que estos
// tests no se rompan solos con el paso del tiempo: se busca el próximo
// lunes, martes o jueves (días de atención completos) con al menos T+3.
const MESES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const DIAS_SEMANA = [
    "domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado",
];

function nextFullScheduleDate(daysAhead = 3) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + daysAhead);

    while (![1, 2, 4].includes(date.getDay())) {
        date.setDate(date.getDate() + 1);
    }

    const day = date.getDate();
    const month = date.getMonth() + 1;
    const ymd = `${date.getFullYear()}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const ddmm = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;

    return {
        ymd,
        ddmm,
        weekdayName: DIAS_SEMANA[date.getDay()],
        monthName: MESES[date.getMonth()],
        day,
    };
}

test("el menú detecta una solicitud directa de cita con fecha escrita", async () => {
    const target = nextFullScheduleDate();
    const result = await chatbotResponse(
        `citas para ${target.weekdayName} ${target.day} de ${target.monthName}`,
        { state: "MENU", data: {}, isNew: false },
        { from: "+573203269984", numMedia: 0 },
    );

    assert.equal(result.nextState, "AGENDAR");
    assert.equal(result.data.step, "ASK_NAME");
    assert.equal(result.data.pendingDateInput, target.ddmm);
    assert.equal(result.data.aiSchedulingEnabled, true);
    assert.match(result.response, new RegExp(target.ddmm.replace("/", "\\/")));
});

test("la fecha escrita en el menú se usa al terminar el filtro de columna", async () => {
    const target = nextFullScheduleDate();
    const result = await agendarState(
        "1",
        {
            step: "FILTRO_COLUMNA",
            pendingDateInput: target.ddmm,
            consultationMode: "PRESENCIAL",
            aiSchedulingEnabled: true,
        },
        { from: "+573203269984" },
    );

    assert.equal(result.nextState, "AGENDAR");
    assert.equal(result.data.date, target.ddmm);
    assert.equal(result.data.ymd, target.ymd);
    assert.equal(result.data.pendingDateInput, undefined);
    assert.equal(result.data.step, "ASK_TIME");
    assert.equal(result.sendTemplate, true);
    assert.equal(result.template.variables["1"], target.ddmm);
});

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

test("teleconsulta notifica a la secretaría en vez de abrir agendamiento con IA (commit 612ff2b, 13-ago)", async () => {
    const result = await teleconsultaState("teleconsulta_agendar", {}, {});

    assert.equal(result.nextState, "MENU");
    assert.equal(result.data.renderMenu, true);
    assert.match(result.response, /secretaria/i);
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
