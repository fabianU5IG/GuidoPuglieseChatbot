-- Esquema de base de datos del chatbot (twilio-chatbot).
-- Ejecutar una sola vez contra un MySQL vacío antes de arrancar el bot:
--   mysql -u root -p < db/schema.sql
-- Las credenciales (DB_HOST, DB_USER, DB_PASS, DB_NAME) se configuran en .env.

CREATE DATABASE IF NOT EXISTS guido_pugliese_chatbot
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE guido_pugliese_chatbot;

CREATE TABLE IF NOT EXISTS patients (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(32) NOT NULL,
  full_name VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_patients_phone (phone)
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS chat_sessions (
  phone VARCHAR(32) NOT NULL PRIMARY KEY,
  state VARCHAR(64) NOT NULL DEFAULT 'MENU',
  data JSON NULL,
  memory JSON NULL,
  session_started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_chat_sessions_last_activity (last_activity_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS appointments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  patient_id INT UNSIGNED NOT NULL,
  scheduled_date DATE NULL,
  scheduled_time TIME NULL,
  duration_minutes INT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PROPOSED',
  source VARCHAR(32) NOT NULL DEFAULT 'BOT',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_appointments_patient (patient_id),
  KEY idx_appointments_date_time (scheduled_date, scheduled_time),
  CONSTRAINT fk_appointments_patient FOREIGN KEY (patient_id) REFERENCES patients(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS appointment_status_history (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  appointment_id INT UNSIGNED NOT NULL,
  previous_status VARCHAR(32) NULL,
  new_status VARCHAR(32) NOT NULL,
  changed_by VARCHAR(32) NOT NULL DEFAULT 'SYSTEM',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ash_appointment (appointment_id),
  CONSTRAINT fk_ash_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS appointment_messages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  appointment_id INT UNSIGNED NOT NULL,
  direction VARCHAR(8) NOT NULL DEFAULT 'IN',
  message TEXT NULL,
  channel VARCHAR(16) NOT NULL DEFAULT 'WHATSAPP',
  provider VARCHAR(16) NOT NULL DEFAULT 'TWILIO',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_am_appointment (appointment_id),
  CONSTRAINT fk_am_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS saludtools_jobs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  job_type VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  priority INT NOT NULL DEFAULT 100,
  phone VARCHAR(32) NULL,
  appointment_id INT UNSIGNED NULL,
  dedupe_key VARCHAR(191) NULL,
  payload JSON NULL,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 30,
  next_run_at DATETIME NOT NULL,
  external_id VARCHAR(64) NULL,
  last_error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_saludtools_jobs_dedupe (dedupe_key),
  KEY idx_saludtools_jobs_pick (status, next_run_at, priority)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS saludtools_patients (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  saludtools_id BIGINT NULL,
  event_type VARCHAR(64) NULL,
  full_name VARCHAR(255) NULL,
  birth_date DATE NULL,
  gender TINYINT NULL,
  habeas_data TINYINT(1) NULL,
  document_type INT NOT NULL,
  document_number VARCHAR(32) NOT NULL,
  raw_payload JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_saludtools_patients_doc (document_type, document_number)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS saludtools_appointments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  saludtools_id BIGINT NOT NULL,
  event_type VARCHAR(64) NULL,
  status VARCHAR(32) NULL,
  start_date DATE NULL,
  start_time TIME NULL,
  end_date DATE NULL,
  end_time TIME NULL,
  doctor_document_number VARCHAR(32) NULL,
  patient_document_type INT NULL,
  patient_document_number VARCHAR(32) NULL,
  clinic VARCHAR(32) NULL,
  raw_payload JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_saludtools_appointments_id (saludtools_id),
  KEY idx_saludtools_appointments_date (start_date, doctor_document_number),
  KEY idx_saludtools_appointments_patient (patient_document_type, patient_document_number)
) ENGINE=InnoDB;

-- Imágenes postoperatorias recibidas por WhatsApp.
-- Se guardan en MySQL para no depender de Supabase ni de almacenamiento local.
-- public_token funciona como secreto no adivinable de la URL pública.
CREATE TABLE IF NOT EXISTS post_surgery_media (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_token CHAR(64) NOT NULL,
  patient_phone VARCHAR(32) NULL,
  patient_name VARCHAR(255) NULL,
  patient_document VARCHAR(64) NULL,
  note TEXT NULL,
  content_type VARCHAR(100) NOT NULL,
  file_extension VARCHAR(12) NOT NULL,
  image_data LONGBLOB NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  public_url VARCHAR(1024) NOT NULL,
  expires_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_post_surgery_media_token (public_token),
  KEY idx_post_surgery_media_expiry (expires_at),
  KEY idx_post_surgery_media_phone (patient_phone)
) ENGINE=InnoDB;

-- Casos de secretaría que no son una cita agendada (ej: revisión de foto
-- postoperatoria, soporte postquirúrgico general). Antes solo existían como
-- un mensaje de WhatsApp a la secretaria, sin registro consultable si ese
-- mensaje fallaba o se perdía entre el resto de mensajes.
CREATE TABLE IF NOT EXISTS secretary_cases (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  patient_phone VARCHAR(32) NOT NULL,
  patient_name VARCHAR(255) NULL,
  patient_document VARCHAR(64) NULL,
  reason VARCHAR(64) NOT NULL,
  note TEXT NULL,
  media_url VARCHAR(1024) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  resolved_by VARCHAR(32) NULL,
  KEY idx_secretary_cases_status (status),
  KEY idx_secretary_cases_phone (patient_phone)
) ENGINE=InnoDB;

-- Días/rangos en los que la secretaria marcó al doctor como no disponible
-- (ej: "el jueves no está" dicho en lenguaje natural desde el panel). Se
-- revisa junto con el horario semanal fijo antes de ofrecer horarios.
CREATE TABLE IF NOT EXISTS doctor_unavailability (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  start_time TIME NULL,
  end_time TIME NULL,
  reason VARCHAR(255) NULL,
  created_by VARCHAR(32) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_doctor_unavailability_range (start_date, end_date)
) ENGINE=InnoDB;
