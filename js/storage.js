const SUPABASE_URL = "https://ypjqxvkqsuyouoriddsk.supabase.co";
const SUPABASE_KEY = "sb_publishable_Abw6VRU3DRyyZImLyg0w-A_94w0qIND";
const STORAGE_KEY = "progreso_tests"; // Cámbialo si tu clave actual en localStorage se llama distinto
const USER_ROW_ID = "mi_progreso";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Lee el progreso local (instantáneo)
function obtenerProgresoLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

// Guarda en local Y sube a Supabase automáticamente
async function guardarProgreso(progreso) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progreso));

  const { error } = await supabaseClient
    .from("progreso")
    .upsert({
      id: USER_ROW_ID,
      datos: progreso,
      updated_at: new Date().toISOString()
    });

  if (error) {
    console.error("Error guardando en Supabase:", error);
  }
}

// Descarga el progreso desde Supabase al abrir la web
async function sincronizarDesdeNube() {
  const { data, error } = await supabaseClient
    .from("progreso")
    .select("datos")
    .eq("id", USER_ROW_ID)
    .maybeSingle();

  if (error) {
    console.error("Error leyendo de Supabase:", error);
    return obtenerProgresoLocal();
  }

  if (data && data.datos) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data.datos));
    return data.datos;
  }

  return obtenerProgresoLocal();
}
