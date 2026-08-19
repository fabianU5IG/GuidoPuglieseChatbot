import { createClient } from "@supabase/supabase-js";

const bucketName = process.env.SUPABASE_BUCKET || "post-surgery";

// El cliente se crea solo la primera vez que realmente se necesita (al subir
// una imagen postquirúrgica), no al importar el módulo. Así, si falta la
// configuración de Supabase, solo falla esa función puntual en vez de tumbar
// todo el proceso del bot al iniciar (Supabase no hace falta para el resto
// de los flujos: menú, agendamiento, gestión de citas, teleconsulta, etc.).
let supabase = null;

function getSupabaseClient() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        throw new Error(
            "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en variables de entorno.",
        );
    }

    if (!supabase) {
        supabase = createClient(supabaseUrl, supabaseKey);
    }

    return supabase;
}

function buildSafeFileName(patientPhone = "unknown", originalExt = "jpg") {
    const cleanPhone = String(patientPhone).replace(/\D/g, "") || "unknown";
    const timestamp = Date.now();
    return `post-surgery/${cleanPhone}-${timestamp}.${originalExt}`;
}

function getExtensionFromContentType(contentType = "") {
    const map = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/heic": "heic",
    };

    return map[contentType.toLowerCase()] || "jpg";
}

export async function uploadPatientImageToSupabase({
    fileBuffer,
    patientPhone,
    contentType = "image/jpeg",
}) {
    const extension = getExtensionFromContentType(contentType);
    const filePath = buildSafeFileName(patientPhone, extension);
    const supabase = getSupabaseClient();

    const { error: uploadError } = await supabase.storage
        .from(bucketName)
        .upload(filePath, fileBuffer, {
            contentType,
            upsert: false,
        });

    if (uploadError) {
        throw uploadError;
    }

    const { data } = supabase.storage.from(bucketName).getPublicUrl(filePath);

    if (!data?.publicUrl) {
        throw new Error("No se pudo obtener la URL pública de Supabase.");
    }

    return {
        filePath,
        publicUrl: data.publicUrl,
    };
}
