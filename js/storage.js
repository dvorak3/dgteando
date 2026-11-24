const SUPABASE_URL = "https://ypjqxvkqsuyouoriddsk.supabase.co";
const SUPABASE_KEY = "sb_publishable_Abw6VRU3DRyyZImLyg0w-A_94w0qIND";
const STORAGE_KEY = "progreso_tests";
const USER_ROW_ID = "mi_progreso";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Lee el progreso local (usado por index.html y los tests)
function obtenerProgreso() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

// Guarda en localStorage Y sube a Supabase
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
    return obtenerProgreso();
  }

  if (data && data.datos) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data.datos));
    return data.datos;
  }

  return obtenerProgreso();
}

// Guarda el resultado de un test individual (para cuando acabes un test)
async function guardarResultadoTest(claveTest, aciertos, fallos, total = 30) {
  const progreso = obtenerProgreso();
  const anterior = progreso[claveTest] || { intentos: 0 };

  const hoy = new Date();
  const dia = String(hoy.getDate()).padStart(2, "0");
  const mes = String(hoy.getMonth() + 1).padStart(2, "0");
  const anio = hoy.getFullYear();

  progreso[claveTest] = {
    intentos: (anterior.intentos || 0) + 1,
    aciertos: aciertos,
    fallos: fallos,
    total: total,
    ultimo: `${dia}/${mes}/${anio}`
  };

  await guardarProgreso(progreso);
}

// Exporta a archivo .json
function exportarJSON() {
  const datos = JSON.stringify(obtenerProgreso(), null, 2);
  const blob = new Blob([datos], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "resultados_tests.json";
  a.click();
  URL.revokeObjectURL(url);
}

// Importa desde archivo .json y lo sube directo a Supabase
function importarJSON(archivo, callback) {
  const lector = new FileReader();
  lector.onload = async (e) => {
    try {
      const datos = JSON.parse(e.target.result);
      await guardarProgreso(datos);
      if (callback) callback();
      alert("Progreso cargado y sincronizado en la nube correctamente.");
    } catch (err) {
      alert("El archivo JSON no tiene un formato válido.");
      console.error(err);
    }
  };
  lector.readAsText(archivo);
}

// Borra todo el progreso local y en Supabase
async function borrarProgreso() {
  await guardarProgreso({});
}
