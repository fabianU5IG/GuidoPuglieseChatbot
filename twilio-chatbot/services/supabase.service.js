import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucketName = process.env.SUPABASE_BUCKET || "post-surgery";

if (!supabaseUrl || !supabaseKey) {
    throw new Error(
        "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en variables de entorno.",
    );
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log(
    "SUPABASE_SERVICE_ROLE_KEY cargada:",
    !!process.env.SUPABASE_SERVICE_ROLE_KEY,
);
console.log("SUPABASE_BUCKET:", process.env.SUPABASE_BUCKET);

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
