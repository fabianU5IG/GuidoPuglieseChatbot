import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db/mysql.js";

process.env.TWILIO_ACCOUNT_SID ||= "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ||= "test_auth_token";
process.env.TWILIO_WHATSAPP_NUMBER ||= "+573114811385";
process.env.SECRETARY_WHATSAPP_NUMBER ||= "+573224811542";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test_service_role_key";

const { default: menuState } = await import("../states/menu.state.js");
const { default: agendarState } = await import("../states/agendar.state.js");
const { default: dashboardState } = await import("../states/dashboard.state.js");

// El test de "citas rápidas" guarda de verdad en MySQL (necesita las
// credenciales reales de .env), y el pool de mysql2 deja una conexión
// abierta que nunca deja terminar el proceso de `node --test` por su cuenta.
// Sin este cierre, `npm test` se queda colgado para siempre.
after(async () => {
    await db.end();
});

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

test("gestión de citas envía la plantilla de Twilio, sin restricciones de columna o pediatría", async () => {
    // Desde "fix: SID nuevo de gestion cita" el menú de gestión de citas se
    // envía como Content Template de Twilio en vez de texto plano.
    const result = await menuState("1", {}, {});

    assert.equal(result.nextState, "GESTION_CITAS");
    assert.equal(result.sendTemplate, true);
    assert.ok(result.template?.contentSid);
});

test("las citas rápidas se guardan localmente y también se encolan para SaludTools", async () => {
    // Documento único por corrida: si se reusara uno fijo, la segunda vez que
    // corriera este test contra la BD real ya existiría la cita local y
    // "created" quedaría en false, sin encolar nada nuevo para Saludtools.
    const uniqueDoc = `1${Date.now()}`.slice(0, 10);

    const result = await dashboardState(
        `presencial 15/09 08:30 cc ${uniqueDoc}`,
        { step: "QUICK_BULK_MESSAGE" },
        { from: "+573153573131" },
    );

    assert.equal(result.nextState, "DASHBOARD");
    assert.match(result.response, /Guardadas en la base de datos/i);
    assert.match(result.response, /Citas registradas localmente/i);
    assert.match(result.response, /sincronizando con Saludtools/i);

    const [rows] = await db.query(
        "SELECT id FROM saludtools_jobs WHERE job_type = 'APPOINTMENT_CREATE' AND dedupe_key LIKE ?",
        [`dashboard-appointment-create:1:${uniqueDoc}:%`],
    );
    assert.ok(
        rows.length > 0,
        "debe quedar encolado un job APPOINTMENT_CREATE para Saludtools",
    );
});
