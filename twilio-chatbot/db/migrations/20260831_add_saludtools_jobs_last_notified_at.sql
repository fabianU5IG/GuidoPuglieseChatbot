-- El paciente/secretaria no recibía ningún aviso mientras un job de
-- saludtools_jobs seguía pendiente (PENDING/RETRY/PROCESSING) sin errores de
-- por medio -- el único mensaje intermedio existente ("Seguimos procesando")
-- solo se disparaba al 5to intento de un reintento por error, así que un job
-- simplemente atascado en la cola (ej: por prioridad, o esperando su turno)
-- podía tardar mucho tiempo sin dar ninguna señal de vida. Este campo permite
-- que el worker avise cada cierto tiempo mientras el job siga sin resolverse,
-- sin depender de que haya habido un error. Ejecutar una vez en la base
-- existente (local y luego Hostinger).
ALTER TABLE saludtools_jobs
  ADD COLUMN last_notified_at TIMESTAMP NULL DEFAULT NULL AFTER updated_at;
