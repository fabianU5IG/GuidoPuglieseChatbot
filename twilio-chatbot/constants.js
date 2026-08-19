export const SALUDTOOLS = {
  DOCTOR_DOCUMENT_TYPE: 1,
  DOCTOR_DOCUMENT_NUMBER: "72134079",
  CLINIC_ID: 18569,
  // Debe coincidir con SLOT_MIN en agendar.state.js / soporteCita.state.js
  // (la grilla de horarios que se le ofrece al paciente es cada 20 minutos).
  APPOINTMENT_DURATION_MIN: 20,
  MODALITY_DEFAULT: "CONVENTIONAL",
  STATE_DEFAULT: "PENDING",
};

export const EPS_CONVENIO = {
  // clave normalizada -> { id: <id_saludtools>, label: "..." }
  "colsanitas": { id: 165, label: "COLSANITAS" },
  "allianz": { id: 169, label: "ALLIANZ" },
  "coomeva": { id: 171, label: "COOMEVA" },
  "medplus": { id: 162, label: "MEDPLUS" },
  "medisanitas": { id: 3, label: "MEDISANITAS" },
  "suramericana": { id: 3, label: "SURAMERICANA" },
};

// si Saludtools NO tiene EPS “Particular”, entonces usamos 0
export const EPS_PARTICULAR_ID = 0;

// Números autorizados como secretaría (solo dígitos, sin "+" ni "whatsapp:").
// Se puede sobreescribir con SECRETARY_PHONES="numero1,numero2" en variables de entorno.
export const SECRETARY_PHONES = (process.env.SECRETARY_PHONES || "573153573132")
  .split(",")
  .map((phone) => phone.trim())
  .filter(Boolean);