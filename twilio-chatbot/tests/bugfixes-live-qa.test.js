import test from "node:test";
import assert from "node:assert/strict";

process.env.TWILIO_ACCOUNT_SID ||= "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ||= "test_auth_token";
process.env.TWILIO_WHATSAPP_NUMBER ||= "+573114811385";
process.env.SECRETARY_WHATSAPP_NUMBER ||= "+573203269984";

const { default: infoCostosState } = await import(
    "../states/infoCostos.state.js"
);
const { default: agendarState } = await import("../states/agendar.state.js");
const { default: gestionCitasState } = await import(
    "../states/gestionCitas.state.js"
);

// Bug reportado en QA en vivo: la plantilla real de info/costos
// (HX5256580c02d8a037cbafa7e5a3c1fd55) usa el id de botón "costos_volver"
// para "Volver", no "volver" a secas. Antes del fix, ese payload no calzaba
// con ninguna de las variantes de isBackIntent y caía en isInfoIntent (por
// incluir la palabra "costos"), repitiendo la misma plantilla y dejando al
// paciente atascado ahí.
test("el botón real 'Volver' de info/costos (costos_volver) regresa al menú", async () => {
    const result = await infoCostosState(
        "costos_volver",
        { origin: "INFO_COSTOS" },
        {},
    );

    assert.equal(result.nextState, "MENU");
    assert.equal(result.sendTemplate, true);
});

// Bug reportado en QA en vivo: el worker de saludtools (saludtools.worker.js)
// puede confirmar la cita y avisarle al paciente ANTES de que responda
// "Entendido" a la plantilla de solicitud registrada. Sin la consulta de
// estado, el bot repetía "seguimos procesando" a alguien cuya cita ya estaba
// confirmada. Aquí no hay MySQL real disponible, así que la consulta de
// estado falla y debe degradar exactamente al mensaje genérico de siempre,
// sin lanzar ni dejar al paciente sin respuesta.
test("POST_CREATED responde 'Entendido' sin romperse cuando no se puede leer el estado real", async () => {
    const result = await agendarState(
        "1",
        {
            step: "POST_CREATED",
            firstName: "Juan",
            appointmentId: 999999,
            consultationMode: "PRESENCIAL",
            aiSchedulingEnabled: true,
        },
        { from: "+573001112233" },
    );

    assert.equal(result.nextState, "MENU");
    assert.match(result.response, /Juan/);
    assert.match(result.response, /procesando/i);
});

// Bug reportado en QA en vivo: "Perfecto, Paciente. Ya tengo tus datos de
// esta sesión" en vez del nombre real. Causa raíz: al entrar a
// cancelar/reagendar desde GESTION_CITAS, startAppointmentSupport() metía el
// literal "Paciente" en data.firstName, que luego se guardaba en la memoria
// de sesión (Fabian) y pisaba el nombre real que el paciente ya había dado
// antes en la misma sesión.
test("cancelar/reagendar cita no pisa el nombre real ya conocido en la sesión", async () => {
    const dataConNombreConocido = {
        rendered: true,
        firstName: "Jorge",
        fullName: "Jorge Ramos",
    };

    const cancelar = await gestionCitasState(
        "cancelar cita",
        dataConNombreConocido,
        {},
    );
    assert.equal(cancelar.data.firstName, "Jorge");
    assert.equal(cancelar.template.variables?.["1"], "Jorge");

    const reagendar = await gestionCitasState(
        "reagendar cita",
        dataConNombreConocido,
        {},
    );
    assert.equal(reagendar.data.firstName, "Jorge");
    assert.equal(reagendar.template.variables?.["1"], "Jorge");
});

test("cancelar/reagendar cita sin nombre conocido sigue saludando como 'Paciente'", async () => {
    const result = await gestionCitasState("cancelar cita", { rendered: true }, {});

    assert.equal(result.data.firstName, undefined);
    assert.equal(result.template.variables?.["1"], "Paciente");
});

// Bug reportado en QA en vivo (transcripción real de WhatsApp): en REG_EPS,
// cualquier texto no reconocido se guardaba tal cual como si fuera el nombre
// de la EPS del paciente. Jorge escribió "uy me equivoqué en la pregunta
// anterior que pena" (quería corregir el teléfono que acababa de dar) y el
// bot lo guardó como epsName y siguió de largo hacia Habeas Data, sin darse
// cuenta ni ofrecer forma de corregirlo.
//
// La detección de "quiere corregir un dato anterior" la decide la IA
// (classifyRegistrationInputAI), no una lista fija de frases — sin
// credenciales reales de Azure aquí, debe degradar exactamente al
// comportamiento de antes (se acepta el texto tal cual) sin romperse.
test("sin IA disponible, REG_EPS sigue aceptando el texto tal cual (degradación segura)", async () => {
    const data = {
        step: "REG_EPS",
        regPatient: { phone: "1109660617" },
        fullName: "Jorge Ramos",
        firstName: "Jorge",
    };

    const result = await agendarState(
        "uy me equivoqué en la pregunta anterior que pena",
        data,
        { from: "+573001112233" },
    );

    assert.equal(result.data.step, "REG_HABEAS");
    assert.equal(result.sendTemplate, true);
});
