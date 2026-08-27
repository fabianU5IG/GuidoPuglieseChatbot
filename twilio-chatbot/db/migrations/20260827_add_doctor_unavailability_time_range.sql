-- La secretaria puede bloquear solo un rango de horas de un día (ej: "no
-- está disponible de 8 a 9"), no necesariamente el día completo. Antes
-- cualquier bloqueo tapaba el día entero aunque solo se avisara una hora
-- puntual. NULL en ambas columnas sigue significando "todo el día".
-- Ejecutar una vez en la base existente (local y luego Hostinger), después
-- de 20260827_add_doctor_unavailability.sql.
ALTER TABLE doctor_unavailability
  ADD COLUMN start_time TIME NULL AFTER end_date,
  ADD COLUMN end_time TIME NULL AFTER start_time;
