-- Memoria durable de conversación por número de WhatsApp.
-- Ejecutar una vez en la base de datos existente.

CREATE TABLE IF NOT EXISTS chat_sessions (
  phone VARCHAR(32) NOT NULL PRIMARY KEY,
  state VARCHAR(64) NOT NULL DEFAULT 'MENU',
  data JSON NULL,
  memory JSON NULL,
  session_started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_chat_sessions_last_activity (last_activity_at)
) ENGINE=InnoDB;
