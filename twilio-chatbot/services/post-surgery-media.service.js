import { randomBytes } from "node:crypto";
import { db } from "../db/mysql.js";

const DEFAULT_TTL_HOURS = 72;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function normalizeBaseUrl(value = "") {
    return String(value || "")
        .trim()
        .replace(/\/+$/, "");
}

function resolvePublicBaseUrl(publicBaseUrl = "") {
    const baseUrl = normalizeBaseUrl(
        publicBaseUrl || process.env.PUBLIC_BASE_URL || "",
    );

    if (!baseUrl) {
        throw new Error(
            "No se pudo determinar la URL pública del bot. Usa el webhook mediante ngrok/HTTPS o configura PUBLIC_BASE_URL.",
        );
    }

    if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error(
            `PUBLIC_BASE_URL inválida: ${baseUrl}. Debe comenzar por http:// o https://`,
        );
    }

    return baseUrl;
}

function getExtensionFromContentType(contentType = "") {
    const normalized = String(contentType || "")
        .toLowerCase()
        .split(";")[0]
        .trim();

    const map = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/heic": "heic",
        "image/heif": "heif",
    };

    return map[normalized] || "jpg";
}

function getMediaTtlHours() {
    const configured = Number(process.env.POST_SURGERY_MEDIA_TTL_HOURS);
    if (!Number.isFinite(configured)) return DEFAULT_TTL_HOURS;

    // Un valor <= 0 desactiva la expiración.
    return configured <= 0 ? 0 : Math.max(1, Math.floor(configured));
}

function getMaxMediaBytes() {
    const configured = Number(process.env.POST_SURGERY_MEDIA_MAX_BYTES);
    if (!Number.isFinite(configured) || configured <= 0) {
        return DEFAULT_MAX_BYTES;
    }

    return Math.floor(configured);
}

function buildExpirationDate(ttlHours) {
    if (!ttlHours) return null;
    return new Date(Date.now() + ttlHours * 60 * 60 * 1000);
}

/**
 * Guarda la imagen directamente en MySQL como LONGBLOB y crea una URL
 * pública, aleatoria y distinta para cada archivo. La URL no contiene el
 * teléfono ni el documento del paciente.
 */
export async function savePatientImageToMySql({
    fileBuffer,
    patientPhone,
    patientName = "Paciente postquirúrgico",
    patientDocument = "No disponible",
    note = "",
    contentType = "image/jpeg",
    publicBaseUrl = "",
}) {
    if (!Buffer.isBuffer(fileBuffer) || !fileBuffer.length) {
        throw new Error("La imagen recibida está vacía o no es válida.");
    }

    const normalizedContentType = String(contentType || "image/jpeg")
        .toLowerCase()
        .split(";")[0]
        .trim();

    if (!normalizedContentType.startsWith("image/")) {
        throw new Error(
            `El archivo recibido no es una imagen válida (${normalizedContentType}).`,
        );
    }

    const maxBytes = getMaxMediaBytes();
    if (fileBuffer.length > maxBytes) {
        throw new Error(
            `La imagen supera el tamaño máximo permitido (${maxBytes} bytes).`,
        );
    }

    const token = randomBytes(32).toString("hex");
    const extension = getExtensionFromContentType(normalizedContentType);
    const ttlHours = getMediaTtlHours();
    const expiresAt = buildExpirationDate(ttlHours);
    const baseUrl = resolvePublicBaseUrl(publicBaseUrl);
    const publicUrl = `${baseUrl}/media/post-surgery/${token}.${extension}`;

    // Limpieza oportunista: no hace falta un cron para la prueba local.
    // Si falla la limpieza, no bloqueamos el guardado de la nueva imagen.
    try {
        await db.query(
            "DELETE FROM post_surgery_media WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP",
        );
    } catch (error) {
        console.warn(
            "⚠️ No se pudieron limpiar imágenes postoperatorias expiradas:",
            error.message,
        );
    }

    await db.query(
        `
        INSERT INTO post_surgery_media
            (public_token, patient_phone, patient_name, patient_document,
             note, content_type, file_extension, image_data, byte_size,
             public_url, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
            token,
            String(patientPhone || ""),
            String(patientName || "Paciente postquirúrgico"),
            String(patientDocument || "No disponible"),
            String(note || ""),
            normalizedContentType,
            extension,
            fileBuffer,
            fileBuffer.length,
            publicUrl,
            expiresAt,
        ],
    );

    return {
        token,
        extension,
        contentType: normalizedContentType,
        publicUrl,
        expiresAt,
        byteSize: fileBuffer.length,
    };
}

/**
 * Recupera una imagen por el token secreto de su URL.
 * No requiere autenticación adicional porque Twilio necesita descargarla
 * directamente; el token aleatorio funciona como credencial no adivinable.
 */
export async function getPostSurgeryMediaByToken(token) {
    const safeToken = String(token || "").trim().toLowerCase();

    if (!/^[a-f0-9]{64}$/.test(safeToken)) {
        return null;
    }

    const [rows] = await db.query(
        `
        SELECT
            public_token,
            content_type,
            file_extension,
            image_data,
            byte_size,
            expires_at
        FROM post_surgery_media
        WHERE public_token = ?
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        LIMIT 1
        `,
        [safeToken],
    );

    return rows[0] || null;
}
