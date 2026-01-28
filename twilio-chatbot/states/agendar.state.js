const { getTimeSlots } = require("../utils/time");
const { buildDoctoraliaRedirect } = require("../services/doctoralia.service");

function agendarState(state, msg, rawMsg, data) {
  switch (state) {
    case "AGENDAR_NOMBRE":
      data.nombre = rawMsg;
      return { response: "¿Es tu primera vez?\n1️⃣ Sí\n2️⃣ No", nextState: "AGENDAR_PRIMERA_VEZ", data };
    case "AGENDAR_PRIMERA_VEZ":
      data.primeraVez = msg === "1" ? "Sí" : "No";
      return { response: "¿Cómo deseas tu cita?\n1️⃣ Presencial\n2️⃣ En línea", nextState: "AGENDAR_MODALIDAD", data };
    case "AGENDAR_MODALIDAD":
      data.modalidad = msg === "2" ? "Consulta en línea" : "Visita presencial";
      return { response: "Servicio:\n1️⃣ Ortopedia\n2️⃣ Consulta", nextState: "AGENDAR_SERVICIO", data };
    case "AGENDAR_SERVICIO":
      data.servicio = msg === "2" ? "Consulta de Ortopedia y Traumatología" : "Visita Ortopedia y Traumatología";
      return { response: "Fecha (YYYY-MM-DD)", nextState: "AGENDAR_FECHA", data };
    case "AGENDAR_FECHA":
      data.fechaISO = rawMsg;
      return {
        response: getTimeSlots().slice(0,6).map((h,i)=>`${i+1}️⃣ ${h}`).join("\n"),
        nextState: "AGENDAR_HORA",
        data
      };
    case "AGENDAR_HORA":
      data.hora = getTimeSlots()[parseInt(msg)-1];
      const url = buildDoctoraliaRedirect(data);
      return {
        response: `Confirma en Doctoralia:\n\n🔗 ${url}\n\n1️⃣ Hablar con secretaría\n2️⃣ Volver al menú`,
        nextState: "POST_DOCTORALIA",
        data
      };
  }
}
module.exports = agendarState;
