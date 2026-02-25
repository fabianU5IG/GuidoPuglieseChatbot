export default async function soporteCitaState(msg, data = {}, context = {}) {
    const { tipo, step } = data;

    // Paso 1: pedir documento
    if (step === "ASK_DOCUMENT") {
        const documento = msg.trim();

        if (!/^\d+$/.test(documento)) {
            return {
                response:
                    "❌ El número de documento debe contener solo números. Intenta nuevamente:",
                nextState: "SOPORTE_CITA",
                data,
            };
        }

        return {
            response:
                "Gracias. Estamos validando tu información, por favor espera un momento ⏳",
            nextState: "SOPORTE_CITA",
            data: {
                ...data,
                step: "PROCESS",
                documento,
            },
        };
    }

    // Paso 2: procesamiento
    if (step === "PROCESS") {
        try {
            /**
             * Aquí debes integrar la consulta real a SaludTools
             * usando context.api o tu servicio interno.
             * Por ahora lo dejamos simulado.
             */

            const documento = data.documento;

            // Simulación de resultado encontrado
            const citaEncontrada = true;

            if (!citaEncontrada) {
                return {
                    response:
                        "No encontramos citas asociadas a ese documento.\n\n" +
                        "Si necesitas ayuda adicional, puedes escribir *SECRETARIA* para comunicarte con nuestro equipo.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            if (tipo === "REAGENDAR") {
                return {
                    response:
                        "Tu solicitud de reagendamiento fue recibida ✅\n\n" +
                        "Nuestro equipo se comunicará contigo en breve para asignar una nueva fecha.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            if (tipo === "CANCELAR") {
                return {
                    response:
                        "Tu cita fue cancelada correctamente ✅\n\n" +
                        "Si deseas agendar una nueva consulta, puedes hacerlo desde el menú principal.",
                    nextState: "MENU",
                    data: { renderMenu: true },
                };
            }

            // Fallback seguro
            return {
                response:
                    "Hemos recibido tu solicitud.\n\n" +
                    "Si necesitas algo adicional puedes volver al menú.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        } catch (error) {
            console.error("Error en soporteCitaState:", error);

            return {
                response:
                    "⚠️ Ocurrió un error procesando tu solicitud.\n\n" +
                    "Por favor escribe *SECRETARIA* para que podamos ayudarte manualmente.",
                nextState: "MENU",
                data: { renderMenu: true },
            };
        }
    }

    // Fallback general
    return {
        response: "Volviendo al menú principal.",
        nextState: "MENU",
        data: { renderMenu: true },
    };
}
