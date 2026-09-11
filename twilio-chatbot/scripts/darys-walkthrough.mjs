import "dotenv/config";
import dashboardState from "../states/dashboard.state.js";

const from = "+573005376530"; // numero real de Darys

function show(label, msg, result) {
    console.log("\n" + "=".repeat(60));
    console.log(`DARYS ESCRIBE: "${msg}"  (paso anterior: ${label})`);
    console.log("-".repeat(60));
    console.log(result.response);
    console.log("-".repeat(60));
    console.log("siguiente step:", result.data?.step);
}

async function main() {
    let data = { step: "MENU" };

    let r = await dashboardState("Hola", { step: "MENU" }, { from });
    show("inicio", "Hola", r);
    data = r.data;

    r = await dashboardState("1", data, { from });
    show("MENU", "1", r);
    data = r.data;

    // Linea con documento que probablemente no existe localmente
    r = await dashboardState("presencial 20/10 09:00 cc 1109660617", data, { from });
    show("QUICK_BULK_MESSAGE", "presencial 20/10 09:00 cc 1109660617", r);
    data = r.data;

    // OJO: se cancela (0) en vez de confirmar (1) a propósito -- esto es
    // solo un recorrido de UX contra producción, no debe crear una cita
    // real ni encolar nada hacia Saludtools.
    r = await dashboardState("0", data, { from });
    show("QUICK_BULK_CONFIRM (cancelado a propósito)", "0", r);
    data = r.data;

    r = await dashboardState("2", data, { from });
    show("MENU", "2", r);
    data = r.data;

    r = await dashboardState("0", data, { from });
    show("SELECT_CASE / INBOX", "0", r);
    data = r.data;

    r = await dashboardState("3", data, { from });
    show("MENU", "3", r);
    data = r.data;

    r = await dashboardState("0", data, { from });
    show("tras resumen IA", "0", r);
    data = r.data;

    r = await dashboardState("6", data, { from });
    show("MENU", "6", r);
    data = r.data;

    r = await dashboardState("0", data, { from });
    show("FAILED_JOBS_LIST", "0", r);
    data = r.data;

    // Bloqueo de horario: se hace y se deshace de inmediato para no dejar
    // un bloqueo real pendiente en producción solo por este recorrido.
    r = await dashboardState("el próximo lunes el doctor no está disponible", data, { from });
    show("MENU (lenguaje natural, bloqueo)", "el próximo lunes el doctor no está disponible", r);
    data = r.data;

    r = await dashboardState("desbloquea el lunes que viene", data, { from });
    show("deshaciendo el bloqueo de prueba", "desbloquea el lunes que viene", r);
    data = r.data;

    process.exit(0);
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
