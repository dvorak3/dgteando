const SUPABASE_URL = "https://ypjqxvkqsuyouoriddsk.supabase.co";
const SUPABASE_KEY = "sb_publishable_Abw6VRU3DRyyZImLyg0w-A_94w0qIND";
const STORAGE_KEY = "progreso_tests";
const USER_ROW_ID = "mi_progreso";
const FECHA_EXAMEN_DEFECTO = "2026-12-10";
const ANKI_MAX_TEST = 90; // se intenta cargar data/test_001.json ... data/test_090.json

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Resultado de la última subida a Supabase (la UI lo consulta para avisar si solo quedó guardado en local)
let ultimaSincronizacionOk = true;

// Lee el progreso local (usado por index.html y los tests)
function obtenerProgreso() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

// Guarda en localStorage Y sube a Supabase. Devuelve true si la subida a la nube fue bien.
async function guardarProgreso(progreso) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progreso));

  try {
    const { error } = await supabaseClient
      .from("progreso")
      .upsert({
        id: USER_ROW_ID,
        datos: progreso,
        updated_at: new Date().toISOString()
      });

    if (error) {
      console.error("Error guardando en Supabase:", error);
      ultimaSincronizacionOk = false;
      return false;
    }
  } catch (err) {
    console.error("Error guardando en Supabase:", err);
    ultimaSincronizacionOk = false;
    return false;
  }

  ultimaSincronizacionOk = true;
  return true;
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

/* =====================================================================
 *  ANKI: fechas, carga de tests, tarjetas, madurez e intervalos
 * ===================================================================== */

// Fecha local en formato "YYYY-MM-DD"
function fechaISOLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dia}`;
}

function hoyISO() {
  return fechaISOLocal(new Date());
}

function sumarDiasISO(iso, dias) {
  const [y, m, d] = iso.split("-").map(Number);
  return fechaISOLocal(new Date(y, m - 1, d + dias));
}

// Días de "desde" a "hasta" (ambas "YYYY-MM-DD"); negativo si hasta es anterior
function diasEntreISO(desde, hasta) {
  const [y1, m1, d1] = desde.split("-").map(Number);
  const [y2, m2, d2] = hasta.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// Días que faltan para el examen (mínimo 1)
function calcularDiasHastaExamen() {
  return Math.max(1, diasEntreISO(hoyISO(), obtenerFechaExamen()));
}

// Carga data/test_XXX.json (con fallback sin cero inicial: test_73.json). Devuelve null si no existe.
async function cargarDatosTest(n) {
  const nombres = [...new Set([String(n).padStart(3, "0"), String(n)])];
  for (const nombre of nombres) {
    try {
      const resp = await fetch(`data/test_${nombre}.json`);
      if (!resp.ok) continue; // 404: ese test no está disponible
      return await resp.json();
    } catch {
      // red o JSON inválido: se prueba el siguiente nombre
    }
  }
  return null;
}

function preguntasDeDatosTest(data) {
  if (Array.isArray(data)) return data;
  return data && Array.isArray(data.preguntas) ? data.preguntas : null;
}

// Clave de tarjeta: "070_04" = test 70, pregunta nº 4 (preguntaIdx 3)
function claveTarjeta(testId, preguntaIdx) {
  return `${String(testId).padStart(3, "0")}_${String(preguntaIdx + 1).padStart(2, "0")}`;
}

function crearTarjeta(testId, preguntaIdx, hoy = hoyISO()) {
  return {
    testId: Number(testId),
    preguntaIdx: Number(preguntaIdx),
    madurez: "nueva",
    fallos: 0,
    aciertosSeguidos: 0,
    intervaloDias: 0,
    proximaRevision: hoy
  };
}

function obtenerTarjetas() {
  const progreso = obtenerProgreso();
  return progreso._tarjetas && typeof progreso._tarjetas === "object" ? progreso._tarjetas : {};
}

// True si hay que (re)cargar el mazo desde los tests: no hay tarjetas o nunca se inicializó
function necesitaInicializarMazo() {
  const progreso = obtenerProgreso();
  const hayTarjetas = progreso._tarjetas && Object.keys(progreso._tarjetas).length > 0;
  const inicializado = Boolean(progreso._meta && progreso._meta.ankiInicializado);
  return !hayTarjetas || !inicializado;
}

// Carga todos los tests disponibles en data/ e incorpora sus preguntas al mazo como "nueva".
// Es idempotente: no toca las tarjetas que ya existen. Solo entran preguntas con "correcta" conocida.
async function inicializarMazoAnkiDesdeTests() {
  const cargas = await Promise.all(
    Array.from({ length: ANKI_MAX_TEST }, (_, i) =>
      cargarDatosTest(i + 1).then((data) => ({ n: i + 1, data }))
    )
  );

  // Se lee el progreso DESPUÉS de las descargas para no pisar cambios hechos mientras tanto
  const progreso = obtenerProgreso();
  if (!progreso._tarjetas || typeof progreso._tarjetas !== "object") progreso._tarjetas = {};
  if (!progreso._meta || typeof progreso._meta !== "object") progreso._meta = {};

  const hoy = hoyISO();
  let testsCargados = 0;
  let anadidas = 0;

  cargas.forEach(({ n, data }) => {
    const preguntas = preguntasDeDatosTest(data);
    if (!preguntas) return;
    testsCargados++;
    preguntas.forEach((p, idx) => {
      if (!p || typeof p.correcta !== "number") return; // sin respuesta correcta no se puede repasar
      const clave = claveTarjeta(n, idx);
      if (!progreso._tarjetas[clave]) {
        progreso._tarjetas[clave] = crearTarjeta(n, idx, hoy);
        anadidas++;
      }
    });
  });

  if (Object.keys(progreso._tarjetas).length > 0) {
    progreso._meta.ankiInicializado = true;
  }

  await guardarProgreso(progreso);
  return { testsCargados, anadidas, totalMazo: Object.keys(progreso._tarjetas).length };
}

// Intervalo en días según confianza, acotado para no programar más allá del examen
function intervaloPorConfianza(nivel, diasRestantes) {
  if (nivel === "medium") {
    return Math.min(3, Math.max(2, Math.floor(diasRestantes / 3)));
  }
  if (nivel === "easy") {
    return Math.min(5, Math.max(3, Math.floor(diasRestantes / 2)));
  }
  return 0;
}

// Función pura: devuelve el nuevo estado de la tarjeta sin modificar la original
function calcularNuevoEstadoTarjeta(tarjeta, nivelConfianza, diasRestantes, hoy) {
  const asi = Number(tarjeta.aciertosSeguidos) || 0;
  const nueva = { ...tarjeta };

  switch (nivelConfianza) {
    case "again":
      nueva.fallos = (Number(tarjeta.fallos) || 0) + 1;
      nueva.aciertosSeguidos = 0;
      nueva.intervaloDias = 0;
      nueva.madurez = "aprendiendo";
      nueva.proximaRevision = hoy;
      break;

    case "hard":
      nueva.aciertosSeguidos = Math.max(1, asi);
      nueva.intervaloDias = 1;
      nueva.madurez = "aprendiendo";
      nueva.proximaRevision = sumarDiasISO(hoy, 1);
      break;

    case "medium":
      nueva.aciertosSeguidos = asi + 1;
      nueva.intervaloDias = Math.max(1, Math.min(intervaloPorConfianza("medium", diasRestantes), diasRestantes));
      nueva.madurez = nueva.aciertosSeguidos >= 2 ? "joven" : "aprendiendo";
      nueva.proximaRevision = sumarDiasISO(hoy, nueva.intervaloDias);
      break;

    case "easy":
      nueva.aciertosSeguidos = asi + 2;
      nueva.intervaloDias = Math.max(1, Math.min(intervaloPorConfianza("easy", diasRestantes), diasRestantes));
      nueva.madurez = nueva.aciertosSeguidos >= 3 ? "madura" : "joven";
      nueva.proximaRevision = sumarDiasISO(hoy, nueva.intervaloDias);
      break;

    default:
      throw new Error(`Nivel de confianza no válido: ${nivelConfianza}`);
  }

  if (!tarjeta.introducida && tarjeta.madurez === "nueva") nueva.introducida = hoy; // día en que se estudió por 1ª vez
  nueva.ultimaRevision = hoy;
  return nueva;
}

// Días hasta el próximo repaso para cada botón (para mostrarlos en la interfaz)
function previsualizarIntervalosTarjeta(clave) {
  const tarjeta = obtenerTarjetas()[clave];
  if (!tarjeta) return null;
  const hoy = hoyISO();
  const dias = calcularDiasHastaExamen();
  const resultado = {};
  ["hard", "medium", "easy", "again"].forEach((nivel) => {
    resultado[nivel] = calcularNuevoEstadoTarjeta(tarjeta, nivel, dias, hoy).intervaloDias;
  });
  return resultado;
}

// Califica una tarjeta ("again" | "hard" | "medium" | "easy"), la guarda y devuelve su nuevo estado
async function calificarTarjetaAnki(clave, nivelConfianza) {
  const progreso = obtenerProgreso();
  const tarjeta = progreso._tarjetas && progreso._tarjetas[clave];
  if (!tarjeta) throw new Error(`La tarjeta ${clave} no existe en el mazo`);

  const nueva = calcularNuevoEstadoTarjeta(tarjeta, nivelConfianza, calcularDiasHastaExamen(), hoyISO());
  progreso._tarjetas[clave] = nueva;
  await guardarProgreso(progreso);
  return nueva;
}

// Registra (en el objeto progreso, sin guardar) las preguntas falladas de un test como "again"
function registrarFallosEnMazo(progreso, testId, indicesFallados) {
  if (!indicesFallados || !indicesFallados.length) return;
  if (!progreso._tarjetas || typeof progreso._tarjetas !== "object") progreso._tarjetas = {};

  const hoy = hoyISO();
  const dias = calcularDiasHastaExamen();
  indicesFallados.forEach((idx) => {
    const clave = claveTarjeta(testId, idx);
    const tarjeta = progreso._tarjetas[clave] || crearTarjeta(testId, idx, hoy);
    progreso._tarjetas[clave] = calcularNuevoEstadoTarjeta(tarjeta, "again", dias, hoy);
  });
}

// Cola de repaso de hoy y estadísticas del mazo
function obtenerColaRepasoHoy() {
  const hoy = hoyISO();
  const diasRestantes = calcularDiasHastaExamen();
  const entradas = Object.entries(obtenerTarjetas()).map(([clave, t]) => ({ clave, ...t }));

  const porMadurez = { nueva: 0, aprendiendo: 0, joven: 0, madura: 0 };
  entradas.forEach((t) => {
    if (porMadurez[t.madurez] !== undefined) porMadurez[t.madurez]++;
  });

  const noMaduras = entradas.filter((t) => t.madurez !== "madura");
  const cuotaBase = Math.ceil(noMaduras.length / Math.max(1, diasRestantes));

  const vencidas = entradas.filter((t) => t.madurez !== "nueva" && t.proximaRevision <= hoy);
  const nuevas = entradas.filter((t) => t.madurez === "nueva" && t.proximaRevision <= hoy);
  const introducidasHoy = entradas.filter((t) => t.introducida === hoy);
  const vencidasAntiguas = vencidas.filter((t) => t.introducida !== hoy);

  // Todas las vencidas entran siempre; las nuevas solo rellenan lo que falta para la cuota del día
  const cupoNuevas = Math.max(0, cuotaBase - vencidasAntiguas.length - introducidasHoy.length);

  vencidas.sort((a, b) =>
    a.proximaRevision.localeCompare(b.proximaRevision) ||
    (b.fallos || 0) - (a.fallos || 0) ||
    a.clave.localeCompare(b.clave)
  );
  nuevas.sort((a, b) => a.clave.localeCompare(b.clave));

  const colaHoy = [...vencidas, ...nuevas.slice(0, cupoNuevas)];

  return {
    totalMazo: entradas.length,
    nuevas: porMadurez.nueva,
    aprendiendo: porMadurez.aprendiendo,
    jovenes: porMadurez.joven,
    maduras: porMadurez.madura,
    cuotaDiaria: colaHoy.length, // tarjetas pendientes hoy
    cuotaBase,                   // ritmo diario teórico: ceil(no maduras / días hasta el examen)
    diasRestantes,
    colaHoy
  };
}

/* ===================================================================== */

// Guarda el resultado de un test individual (para cuando acabes un test).
// indicesFallados (opcional): índices 0-based de las preguntas falladas; pasan al mazo Anki como "again".
// Devuelve true si todo quedó guardado también en la nube.
async function guardarResultadoTest(claveTest, aciertos, fallos, total = 30, indicesFallados = null) {
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

  const testId = parseInt(String(claveTest).replace(/\D/g, ""), 10);
  if (Number.isFinite(testId)) registrarFallosEnMazo(progreso, testId, indicesFallados);

  return await guardarProgreso(progreso);
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

// Borra los resultados de los tests y el mazo Anki, manteniendo la fecha de examen (_meta)
async function borrarProgreso() {
  const actual = obtenerProgreso();
  const nuevoEstado = {};
  if (actual._meta) {
    const meta = { ...actual._meta };
    delete meta.ankiInicializado;
    nuevoEstado._meta = meta;
  }
  await guardarProgreso(nuevoEstado);
}
