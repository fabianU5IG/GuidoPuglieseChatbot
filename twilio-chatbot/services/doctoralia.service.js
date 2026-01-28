const { DOCTORALIA_BOOKING_START_URL } = require("../constants");

function buildDoctoraliaRedirect(data) {
  const params = new URLSearchParams();
  if (data.fechaISO && data.hora) {
    params.append("date", `${data.fechaISO}T${data.hora}:00`);
  }
  if (data.modalidad) {
    params.append("visitType", data.modalidad === "Consulta en línea" ? "online" : "office");
  }
  if (data.servicio) {
    params.append("reason", data.servicio);
  }
  return `${DOCTORALIA_BOOKING_START_URL}?${params.toString()}`;
}
module.exports = { buildDoctoraliaRedirect };
