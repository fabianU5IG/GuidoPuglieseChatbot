import express from "express";
import { timingSafeEqual } from "node:crypto";
import { syncSaludtoolsAppointment, syncSaludtoolsPatient } from "../services/saludtools-sync.service.js";

const router = express.Router();

const WEBHOOK_SECRET = process.env.SALUDTOOLS_WEBHOOK_SECRET || "";

if (!WEBHOOK_SECRET) {
  console.warn(
    "⚠️  SALUDTOOLS_WEBHOOK_SECRET no está configurado: /webhook/saludtools/* " +
      "acepta solicitudes sin autenticación. Configúralo aquí y en el panel de " +
      "Saludtools (encabezado X-Saludtools-Secret) para cerrar este hueco.",
  );
}

function verifySaludtoolsSecret(req, res, next) {
  if (!WEBHOOK_SECRET) return next();

  const provided = String(req.headers["x-saludtools-secret"] || "");
  const expected = WEBHOOK_SECRET;

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  const valid =
    providedBuf.length === expectedBuf.length &&
    timingSafeEqual(providedBuf, expectedBuf);

  if (!valid) {
    console.warn("🚫 Webhook de Saludtools rechazado: secreto inválido o ausente.");
    return res.sendStatus(401);
  }

  return next();
}

router.use(verifySaludtoolsSecret);

function logWebhook(label, req) {
  console.log(`\n========== SALUDTOOLS WEBHOOK: ${label} ==========`);

  console.log("Headers:");
  console.log(req.headers);

  console.log("Body:");
  console.log(JSON.stringify(req.body, null, 2));

  console.log("=================================================\n");
}

/* Crear cita */
router.post("/appointment/create", async (req, res) => {
  logWebhook("APPOINTMENT_CREATE", req);
  await syncSaludtoolsAppointment("CREATE", req.body);
  return res.sendStatus(200);
});

/* Actualizar cita */
router.post("/appointment/update", async (req, res) => {
  logWebhook("APPOINTMENT_UPDATE", req);
  await syncSaludtoolsAppointment("UPDATE", req.body);
  return res.sendStatus(200);
});

/* Eliminar/cancelar cita */
router.post("/appointment/delete", async (req, res) => {
  logWebhook("APPOINTMENT_DELETE", req);
  await syncSaludtoolsAppointment("DELETE", req.body);
  return res.sendStatus(200);
});

/* Crear paciente */
router.post("/patient/create", async (req, res) => {
  logWebhook("PATIENT_CREATE", req);
  await syncSaludtoolsPatient("CREATE", req.body);
  return res.sendStatus(200);
});

/* Actualizar paciente */
router.post("/patient/update", async (req, res) => {
  logWebhook("PATIENT_UPDATE", req);
  await syncSaludtoolsPatient("UPDATE", req.body);
  return res.sendStatus(200);
});

/* Eliminar paciente */
router.post("/patient/delete", async (req, res) => {
  logWebhook("PATIENT_DELETE", req);
  await syncSaludtoolsPatient("DELETE", req.body);
  return res.sendStatus(200);
});

export default router;