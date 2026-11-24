const SUPABASE_URL = "https://ypjqxvkqsuyouoriddsk.supabase.co";
const SUPABASE_KEY = "sb_publishable_Abw6VRU3DRyyZImLyg0w-A_94w0qIND";
const STORAGE_KEY = "progreso_tests";
const USER_ROW_ID = "mi_progreso";
const FECHA_EXAMEN_DEFECTO = "2026-12-10";

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

// Obtiene la fecha de examen DGT configurada o la fecha por defecto
function obtenerFechaExamen() {
  const progreso = obtenerProgreso();
  if (progreso._meta && typeof progreso._meta.fechaExamen === "string" && /^\d{4}-\d{2}-\d{2}$/.test(progreso._meta.fechaExamen)) {
    return progreso._meta.fechaExamen;
  }
  return FECHA_EXAMEN_DEFECTO;
}

// Guarda la fecha de examen DGT dentro de _meta y sincroniza
async function guardarFechaExamen(nuevaFechaISO) {
  const progreso = obtenerProgreso();
  if (!progreso._meta || typeof progreso._meta !== "object") {
    progreso._meta = {};
  }
  progreso._meta.fechaExamen = nuevaFechaISO;
  await guardarProgreso(progreso);
}

// Calcula la racha actual de días seguidos practicando
function calcularRachaEstudio() {
  const progreso = obtenerProgreso();
  const fechasUnicas = new Set();

  Object.keys(progreso).forEach((clave) => {
    if (!clave.startsWith("test_")) return;
    const item = progreso[clave];
    if (!item || typeof item !== "object") return;

    if (typeof item.ultimo === "string" && /^\d{2}\/\d{2}\/\d{4}$/.test(item.ultimo)) {
      fechasUnicas.add(item.ultimo);
    }

    if (Array.isArray(item.historial)) {
      item.historial.forEach((h) => {
        if (h && typeof h.fecha === "string" && /^\d{2}\/\d{2}\/\d{4}$/.test(h.fecha)) {
          fechasUnicas.add(h.fecha);
        }
      });
    }
  });

  const formatearClaveFecha = (dateObj) => {
    const d = String(dateObj.getDate()).padStart(2, "0");
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const y = dateObj.getFullYear();
    return `${d}/${m}/${y}`;
  };

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  const ayer = new Date(hoy);
  ayer.setDate(ayer.getDate() - 1);

  const hoyStr = formatearClaveFecha(hoy);
  const ayerStr = formatearClaveFecha(ayer);

  const practicoHoy = fechasUnicas.has(hoyStr);
  const practicoAyer = fechasUnicas.has(ayerStr);

  if (!practicoHoy && !practicoAyer) {
    return { dias: 0, practicoHoy: false };
  }

  let racha = 0;
  const cursor = new Date(practicoHoy ? hoy : ayer);

  while (fechasUnicas.has(formatearClaveFecha(cursor))) {
    racha++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { dias: racha, practicoHoy };
}

// Guarda el resultado de un test individual (para cuando acabes un test)
async function guardarResultadoTest(claveTest, aciertos, fallos, total = 30) {
  const progreso = obtenerProgreso();
  const anterior = progreso[claveTest] || { intentos: 0 };

  const hoy = new Date();
  const dia = String(hoy.getDate()).padStart(2, "0");
  const mes = String(hoy.getMonth() + 1).padStart(2, "0");
  const anio = hoy.getFullYear();
  const fechaActual = `${dia}/${mes}/${anio}`;

  let historial = [];

  if (Array.isArray(anterior.historial)) {
    historial = [...anterior.historial];
  } else if ((anterior.intentos || 0) > 0) {
    historial = [
      {
        fecha: anterior.ultimo || "Anterior",
        fallos: Number(anterior.fallos ?? 0)
      }
    ];
  }

  historial.push({
    fecha: fechaActual,
    fallos: Number(fallos)
  });

  progreso[claveTest] = {
    intentos: (anterior.intentos || 0) + 1,
    aciertos: aciertos,
    fallos: fallos,
    total: total,
    ultimo: fechaActual,
    historial: historial
  };

  await guardarProgreso(progreso);
}

// Devuelve el historial de fallos de un test concreto con retrocompatibilidad
function obtenerHistorialTest(claveTest) {
  const progreso = obtenerProgreso();
  const datos = progreso[claveTest];

  if (!datos) {
    return [];
  }

  if (Array.isArray(datos.historial)) {
    return datos.historial;
  }

  if ((datos.intentos || 0) > 0) {
    return [
      {
        fecha: datos.ultimo || "Anterior",
        fallos: Number(datos.fallos ?? 0)
      }
    ];
  }

  return [];
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

// Borra los resultados de los tests manteniendo la fecha de examen (_meta)
async function borrarProgreso() {
  const actual = obtenerProgreso();
  const nuevoEstado = actual._meta ? { _meta: actual._meta } : {};
  await guardarProgreso(nuevoEstado);
}
