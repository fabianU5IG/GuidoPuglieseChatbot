// constants.js
// constants.j
//
/*export const DOCTORALIA = {
    DOCTOR_ID: "115097",
    ADDRESS_ID: "120780",
    SPECIALTY_ID: "457265",
    // Timezone Colombia
    TIMEZONE_OFFSET: "-05:00",
};
*/
export const SALUDTOOLS = {
  DOCTOR_DOCUMENT_TYPE: 1,
  DOCTOR_DOCUMENT_NUMBER: "72134079",
  CLINIC_ID: 18569,
  APPOINTMENT_DURATION_MIN: 30,
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