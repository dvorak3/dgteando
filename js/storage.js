const SUPABASE_URL = "https://ypjqxvkqsuyouoriddsk.supabase.co";
const SUPABASE_KEY = "sb_publishable_Abw6VRU3DRyyZImLyg0w-A_94w0qIND";
const STORAGE_KEY = "progreso_tests";
const USER_ROW_ID = "mi_progreso";
const FECHA_EXAMEN_DEFECTO = "2026-12-10";
const ANKI_MAX_TEST = 90; // se intenta cargar data/test_001.json ... data/test_090.json
let sincronizacionFlagsEnCurso = null;

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Resultado de la última subida a Supabase (la UI lo consulta para avisar si solo quedó guardado en local)
let ultimaSincronizacionOk = true;
let ultimaOperacionGuardarProgreso = Promise.resolve(true);

// Lee el progreso local (usado por index.html y los tests)
function obtenerProgreso() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

// Guarda en localStorage inmediatamente y encola la sincronización remota ordenada.
function guardarProgreso(progreso) {
  const serializado = JSON.stringify(progreso);
  localStorage.setItem(STORAGE_KEY, serializado);
  const datosNube = JSON.parse(serializado);

  const operacion = ultimaOperacionGuardarProgreso.then(async () => {
    try {
      const { error } = await supabaseClient
        .from("progreso")
        .upsert({
          id: USER_ROW_ID,
          datos: datosNube,
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
  });
  ultimaOperacionGuardarProgreso = operacion;
  return operacion;
}

function esperarGuardadoProgreso() {
  return ultimaOperacionGuardarProgreso;
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
    const fusionados = conservarParchesLocalesMasRecientes(data.datos);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fusionados));
    return fusionados;
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

/* =====================================================================
 *  ANKI: configuración (progreso._meta.ankiConfig, sincronizada con Supabase)
 * ===================================================================== */

const ANKI_CONFIG_DEFECTO = Object.freeze({
  modoLimite: "auto",        // "auto" (ajustado al examen) | "personalizado" | "ilimitado"
  limiteDiario: 50,          // solo se usa con modoLimite === "personalizado"
  limiteNuevas: 0,           // 0 = sin tope específico de tarjetas nuevas
  orden: "prioridad",        // "prioridad" | "aleatorio" | "nuevas_primero"
  barajarOpciones: false,    // baraja a/b/c en modo repaso
  limiteEstricto: false      // personalizado: true = respeta el límite exacto aunque haya más vencidas
});
const ANKI_MODOS_LIMITE = ["auto", "personalizado", "ilimitado"];
const ANKI_ORDENES = ["prioridad", "aleatorio", "nuevas_primero"];

// Valida y completa una configuración (valores desconocidos o corruptos vuelven al defecto)
function normalizarConfigAnki(cruda) {
  const c = cruda && typeof cruda === "object" ? cruda : {};
  const D = ANKI_CONFIG_DEFECTO;
  const entero = (v, def, min, max) => {
    if (v === null || v === undefined || v === "") return def;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  return {
    modoLimite: ANKI_MODOS_LIMITE.includes(c.modoLimite) ? c.modoLimite : D.modoLimite,
    limiteDiario: entero(c.limiteDiario, D.limiteDiario, 1, 999),
    limiteNuevas: entero(c.limiteNuevas, D.limiteNuevas, 0, 999),
    orden: ANKI_ORDENES.includes(c.orden) ? c.orden : D.orden,
    barajarOpciones: c.barajarOpciones === true,
    limiteEstricto: c.limiteEstricto === true
  };
}

function obtenerConfigAnki() {
  const progreso = obtenerProgreso();
  const guardada = progreso._meta && typeof progreso._meta === "object" ? progreso._meta.ankiConfig : null;
  return normalizarConfigAnki(guardada);
}

// Guarda (fusionando con la actual) en _meta.ankiConfig y sincroniza. Devuelve true si llegó a la nube.
async function guardarConfigAnki(nuevaConfig) {
  const progreso = obtenerProgreso();
  if (!progreso._meta || typeof progreso._meta !== "object") progreso._meta = {};
  progreso._meta.ankiConfig = normalizarConfigAnki({ ...obtenerConfigAnki(), ...(nuevaConfig || {}) });
  return await guardarProgreso(progreso);
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

/* =====================================================================
 *  PREGUNTAS DEFECTUOSAS: parches locales + flags en Supabase
 * ===================================================================== */

const TABLA_FLAGS = "flags_preguntas";
const FLAG_CONFLICTO = "user_id,pregunta_id";
const TABLA_LOTES_FLAGS = "flags_sesiones";
const FLAGS_COLA_KEY = "flags_sesion_pendientes";
const BUCKET_IMAGENES_FLAGS = "preguntas-pendientes";
const MAX_TAMANO_IMAGEN_FLAG = 5 * 1024 * 1024;
const TIPOS_IMAGEN_FLAG = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
});
let colaFlagsSesionMemoria = null;
let sesionFlagsPromise = null;

function normalizarParchePregunta(crudo) {
  if (!crudo || typeof crudo !== "object") return null;
  const texto = (valor) => (typeof valor === "string" ? valor.trim() : "");
  const enunciado = texto(crudo.enunciado);
  const opciones = Array.isArray(crudo.opciones) ? crudo.opciones.map(texto) : [];
  const { correcta, testId, preguntaIdx } = crudo;

  if (!enunciado || opciones.length < 2 || opciones.length > 3 || opciones.some((opcion) => !opcion)) return null;
  if (!Number.isInteger(correcta) || correcta < 0 || correcta >= opciones.length) return null;
  if (!Number.isInteger(testId) || testId < 1 || !Number.isInteger(preguntaIdx) || preguntaIdx < 0) return null;

  return {
    testId,
    preguntaIdx,
    enunciado,
    opciones,
    correcta,
    esNueva: crudo.esNueva === true,
    explicacion: texto(crudo.explicacion),
    nota: texto(crudo.nota),
    imagen: texto(crudo.imagen),
    imagenStoragePath: texto(crudo.imagenStoragePath),
    creadoEn: typeof crudo.creadoEn === "string" ? crudo.creadoEn : "",
    actualizadoEn: typeof crudo.actualizadoEn === "string" ? crudo.actualizadoEn : "",
    sincronizado: crudo.sincronizado === true
  };
}

function obtenerParchesPreguntas() {
  const crudos = obtenerProgreso()._parchesPreguntas;
  const resultado = {};
  if (!crudos || typeof crudos !== "object") return resultado;
  Object.entries(crudos).forEach(([clave, crudo]) => {
    const parche = normalizarParchePregunta(crudo);
    if (parche) resultado[clave] = parche;
  });
  return resultado;
}

function obtenerParchePregunta(testId, preguntaIdx) {
  const crudos = obtenerProgreso()._parchesPreguntas;
  if (!crudos || typeof crudos !== "object") return null;
  return normalizarParchePregunta(crudos[claveTarjeta(testId, preguntaIdx)]);
}

function conservarParchesLocalesMasRecientes(datosNube) {
  const locales = obtenerProgreso()._parchesPreguntas;
  if (!locales || typeof locales !== "object") return datosNube;

  Object.entries(locales).forEach(([clave, local]) => {
    const parcheLocal = normalizarParchePregunta(local);
    if (!parcheLocal) return;
    const parcheNube = normalizarParchePregunta(datosNube._parchesPreguntas && datosNube._parchesPreguntas[clave]);
    if (!parcheNube || parcheNube.actualizadoEn < parcheLocal.actualizadoEn) {
      if (!datosNube._parchesPreguntas || typeof datosNube._parchesPreguntas !== "object") {
        datosNube._parchesPreguntas = {};
      }
      datosNube._parchesPreguntas[clave] = local;
    }
  });
  return datosNube;
}

function filaFlagDesdeParche(parche, userId) {
  return {
    user_id: userId,
    pregunta_id: claveTarjeta(parche.testId, parche.preguntaIdx),
    test_id: parche.testId,
    pregunta_idx: parche.preguntaIdx,
    enunciado: parche.enunciado,
    opciones: parche.opciones,
    correcta: parche.correcta,
    explicacion: parche.explicacion || null,
    nota: parche.nota || null,
    ...(parche.esNueva ? { es_nueva: true } : {}),
    ...(parche.imagenStoragePath ? { imagen_storage_path: parche.imagenStoragePath } : {})
  };
}

function nuevoIdLoteFlags() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function leerColaFlagsSesion() {
  if (colaFlagsSesionMemoria) return colaFlagsSesionMemoria;
  const serializada = localStorage.getItem(FLAGS_COLA_KEY);
  if (!serializada) return null;
  const cola = JSON.parse(serializada);
  if (!cola || typeof cola.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cola.id)
      || !Array.isArray(cola.flags)) {
    throw new Error("La cola local de correcciones tiene un formato no válido.");
  }
  const flags = cola.flags.map(normalizarParchePregunta);
  if (flags.some((flag) => !flag)) {
    throw new Error("La cola local contiene una corrección no válida.");
  }
  cola.flags = flags;
  colaFlagsSesionMemoria = cola;
  return cola;
}

function guardarColaFlagsSesion(cola) {
  colaFlagsSesionMemoria = cola;
  if (cola) localStorage.setItem(FLAGS_COLA_KEY, JSON.stringify(cola));
  else localStorage.removeItem(FLAGS_COLA_KEY);
}

function encolarFlagSesion(payload) {
  const parche = normalizarParchePregunta(payload);
  if (!parche) throw new Error("No se puede encolar una corrección no válida.");
  const clave = claveTarjeta(parche.testId, parche.preguntaIdx);
  const cola = leerColaFlagsSesion() || { id: nuevoIdLoteFlags(), flags: [] };
  const existentes = cola.flags.filter((flag) =>
    claveTarjeta(flag.testId, flag.preguntaIdx) !== clave
  );
  existentes.push(parche);
  cola.flags = existentes;
  guardarColaFlagsSesion(cola);
  return cola.id;
}

async function obtenerSesionExistente() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  return data && data.session ? data.session : null;
}

async function iniciarSesionAnonimaSiHaceFalta() {
  const sesion = await obtenerSesionExistente();
  if (sesion && sesion.user) return sesion;

  const { data, error } = await supabaseClient.auth.signInAnonymously();
  if (error) throw error;
  if (!data || !data.session || !data.user) {
    throw new Error("Supabase no devolvió una sesión anónima válida.");
  }
  return data.session;
}

function prepararSesionFlags() {
  if (!sesionFlagsPromise) {
    sesionFlagsPromise = iniciarSesionAnonimaSiHaceFalta();
  }
  const tarea = sesionFlagsPromise;
  return tarea.finally(() => {
    if (sesionFlagsPromise === tarea) sesionFlagsPromise = null;
  });
}

function guardarParcheLocal(parche) {
  const progreso = obtenerProgreso();
  if (!progreso._parchesPreguntas || typeof progreso._parchesPreguntas !== "object") {
    progreso._parchesPreguntas = {};
  }
  const clave = claveTarjeta(parche.testId, parche.preguntaIdx);
  progreso._parchesPreguntas[clave] = parche;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progreso));
}

function guardarFlagPregunta(payload) {
  const base = normalizarParchePregunta(payload);
  if (!base) {
    throw new Error("Corrección no válida: revisa el enunciado, las opciones (2 o 3) y la respuesta correcta.");
  }
  const guardar = (imagenSubida = null) => {
    const clave = claveTarjeta(base.testId, base.preguntaIdx);
    const ahora = new Date().toISOString();
    const progreso = obtenerProgreso();
    const previo = normalizarParchePregunta(progreso._parchesPreguntas && progreso._parchesPreguntas[clave]);
    const parche = {
      ...base,
      ...(imagenSubida ? {
        imagen: imagenSubida.url,
        imagenStoragePath: imagenSubida.path
      } : {}),
      creadoEn: (previo && previo.creadoEn) || ahora,
      actualizadoEn: ahora,
      sincronizado: false
    };
    guardarParcheLocal(parche);
    const loteId = encolarFlagSesion(parche);
    prepararSesionFlags().catch((err) => {
      console.error("No se pudo preparar la sesión de Supabase para las correcciones:", err);
    });
    return { ok: true, parche, nube: "pendiente", loteId };
  };

  const archivo = payload && payload.imagenArchivo;
  if (!archivo) return guardar();
  if (typeof archivo.arrayBuffer !== "function" || !TIPOS_IMAGEN_FLAG[archivo.type]) {
    throw new Error("La imagen debe ser JPG, PNG o WebP.");
  }
  if (!Number.isFinite(archivo.size) || archivo.size <= 0 || archivo.size > MAX_TAMANO_IMAGEN_FLAG) {
    throw new Error("La imagen debe ocupar entre 1 byte y 5 MB.");
  }

  return prepararSesionFlags().then(async (sesion) => {
    if (!sesion || !sesion.user || !sesion.user.id) {
      throw new Error("No hay sesión autenticada para subir la imagen.");
    }
    const extension = TIPOS_IMAGEN_FLAG[archivo.type];
    const ruta = `${sesion.user.id}/${base.testId}/${base.preguntaIdx + 1}-${nuevoIdLoteFlags()}.${extension}`;
    const { error } = await supabaseClient.storage
      .from(BUCKET_IMAGENES_FLAGS)
      .upload(ruta, archivo, { contentType: archivo.type, upsert: false });
    if (error) throw new Error(`No se pudo subir la imagen: ${error.message || error}`);
    const { data } = supabaseClient.storage.from(BUCKET_IMAGENES_FLAGS).getPublicUrl(ruta);
    if (!data || !data.publicUrl) throw new Error("Supabase no devolvió la URL pública de la imagen.");
    return guardar({ url: data.publicUrl, path: ruta });
  });
}

async function upsertFlagsConKeepalive(filas, marcador, accessToken) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal"
  };
  const respuestaFlags = await fetch(
    `${SUPABASE_URL}/rest/v1/${TABLA_FLAGS}?on_conflict=${encodeURIComponent(FLAG_CONFLICTO)}`,
    { method: "POST", headers, body: JSON.stringify(filas), keepalive: true }
  );
  if (!respuestaFlags.ok) {
    throw new Error(`Error subiendo el lote de correcciones (${respuestaFlags.status}).`);
  }

  const respuestaMarcador = await fetch(
    `${SUPABASE_URL}/rest/v1/${TABLA_LOTES_FLAGS}?on_conflict=id`,
    {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(marcador),
      keepalive: true
    }
  );
  if (!respuestaMarcador.ok) {
    throw new Error(`Error registrando el lote de correcciones (${respuestaMarcador.status}).`);
  }
}

function sincronizarFlagsSesion({ keepalive = false } = {}) {
  if (sincronizacionFlagsEnCurso) return sincronizacionFlagsEnCurso;
  const tarea = ejecutarSincronizacionFlagsSesion(keepalive);
  sincronizacionFlagsEnCurso = tarea;
  return tarea.finally(() => {
    if (sincronizacionFlagsEnCurso === tarea) sincronizacionFlagsEnCurso = null;
  });
}

async function ejecutarSincronizacionFlagsSesion(keepalive) {
  const cola = leerColaFlagsSesion();
  if (!cola || !cola.flags.length) return { ok: true, enviados: 0, sinCambios: true };

  let sesion;
  if (keepalive) {
    sesion = sesionFlagsPromise ? await sesionFlagsPromise : await obtenerSesionExistente();
  } else {
    sesion = await prepararSesionFlags();
  }
  if (!sesion || !sesion.user || !sesion.access_token) {
    throw new Error("No hay sesión autenticada para subir las correcciones.");
  }

  const enviados = cola.flags.map((parche) => filaFlagDesdeParche(parche, sesion.user.id));
  const marcador = { id: cola.id, user_id: sesion.user.id, flags_count: enviados.length };
  if (keepalive) {
    await upsertFlagsConKeepalive(enviados, marcador, sesion.access_token);
  } else {
    const { error: errorFlags } = await supabaseClient
      .from(TABLA_FLAGS)
      .upsert(enviados, { onConflict: FLAG_CONFLICTO });
    if (errorFlags) throw errorFlags;

    const { error: errorMarcador } = await supabaseClient
      .from(TABLA_LOTES_FLAGS)
      .upsert(marcador, { onConflict: "id", ignoreDuplicates: true });
    if (errorMarcador) throw errorMarcador;
  }

  const progreso = obtenerProgreso();
  const actualizacionesPorClave = new Map(cola.flags.map((parche) => [
    claveTarjeta(parche.testId, parche.preguntaIdx),
    parche.actualizadoEn
  ]));
  enviados.forEach((fila) => {
    const parche = progreso._parchesPreguntas
      && progreso._parchesPreguntas[fila.pregunta_id];
    if (parche && parche.actualizadoEn === actualizacionesPorClave.get(fila.pregunta_id)) {
      parche.sincronizado = true;
    }
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progreso));

  const colaActual = leerColaFlagsSesion();
  const clavesEnviadas = new Set(cola.flags.map((parche) =>
    `${claveTarjeta(parche.testId, parche.preguntaIdx)}:${parche.actualizadoEn}`
  ));
  const restantes = colaActual.flags.filter((parche) =>
    !clavesEnviadas.has(`${claveTarjeta(parche.testId, parche.preguntaIdx)}:${parche.actualizadoEn}`)
  );
  guardarColaFlagsSesion(restantes.length ? { id: nuevoIdLoteFlags(), flags: restantes } : null);
  return { ok: true, enviados: enviados.length, loteId: cola.id };
}

/* =====================================================================
 *  CATEGORÍAS: la clasificación vive en js/categorias.js (cargar antes que este archivo)
 * ===================================================================== */

const SIN_CATEGORIA = "Sin clasificar";
const CATEGORIA_FALLBACK = "Normativa general"; // solo si categorias.js no estuviera cargado

// Categoría de una pregunta del JSON: respeta su campo "categoria" y, si no, la calcula
function categoriaDePregunta(pregunta) {
  if (!pregunta || typeof pregunta !== "object") return CATEGORIA_FALLBACK;
  const explicita = typeof pregunta.categoria === "string" ? pregunta.categoria.trim() : "";
  if (typeof clasificarCategoriaDGT === "function") {
    return clasificarCategoriaDGT(pregunta.texto, explicita, pregunta.opciones);
  }
  return explicita || CATEGORIA_FALLBACK;
}

function crearTarjeta(testId, preguntaIdx, hoy = hoyISO(), categoria = null) {
  const tarjeta = {
    testId: Number(testId),
    preguntaIdx: Number(preguntaIdx),
    madurez: "nueva",
    fallos: 0,
    aciertosSeguidos: 0,
    intervaloDias: 0,
    proximaRevision: hoy
  };
  if (categoria) tarjeta.categoria = categoria;
  return tarjeta;
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

// Descarga en paralelo todos los tests de data/ (1..ANKI_MAX_TEST)
function descargarTodosLosTests() {
  return Promise.all(
    Array.from({ length: ANKI_MAX_TEST }, (_, i) =>
      cargarDatosTest(i + 1).then((data) => ({ n: i + 1, data }))
    )
  );
}

// Incorpora al mazo (en el objeto progreso, sin guardar) las preguntas que aún no tienen tarjeta
// y rellena "categoria" en las tarjetas existentes que no la tengan (migración silenciosa).
// Nunca toca el estado de estudio de las tarjetas existentes.
function incorporarPreguntasAlMazo(progreso, cargas, hoy) {
  const r = { testsCargados: 0, anadidas: 0, testsNuevos: 0, omitidas: 0, categorizadas: 0 };

  cargas.forEach(({ n, data }) => {
    const preguntas = preguntasDeDatosTest(data);
    if (!preguntas) return;
    r.testsCargados++;
    let anadidasTest = 0;
    preguntas.forEach((p, idx) => {
      if (!p || typeof p.correcta !== "number") { r.omitidas++; return; } // sin respuesta correcta no se puede repasar
      const clave = claveTarjeta(n, idx);
      const existente = progreso._tarjetas[clave];
      if (!existente) {
        progreso._tarjetas[clave] = crearTarjeta(n, idx, hoy, categoriaDePregunta(p));
        anadidasTest++;
      } else if (!existente.categoria) {
        existente.categoria = categoriaDePregunta(p);
        r.categorizadas++;
      }
    });
    if (anadidasTest > 0) r.testsNuevos++;
    r.anadidas += anadidasTest;
  });
  return r;
}

// Carga todos los tests disponibles en data/ e incorpora sus preguntas al mazo como "nueva" (con su categoría).
// Es idempotente: no toca las tarjetas que ya existen (solo completa su categoría si faltaba).
async function inicializarMazoAnkiDesdeTests() {
  const cargas = await descargarTodosLosTests();

  // Se lee el progreso DESPUÉS de las descargas para no pisar cambios hechos mientras tanto
  const progreso = obtenerProgreso();
  if (!progreso._tarjetas || typeof progreso._tarjetas !== "object") progreso._tarjetas = {};
  if (!progreso._meta || typeof progreso._meta !== "object") progreso._meta = {};

  const r = incorporarPreguntasAlMazo(progreso, cargas, hoyISO());

  if (Object.keys(progreso._tarjetas).length > 0) {
    progreso._meta.ankiInicializado = true;
  }

  await guardarProgreso(progreso);
  return { testsCargados: r.testsCargados, anadidas: r.anadidas, categorizadas: r.categorizadas, totalMazo: Object.keys(progreso._tarjetas).length };
}

// Recorre TODOS los tests de data/ (1..ANKI_MAX_TEST) y añade como "nueva" cada pregunta cuya clave aún no está
// en el mazo (tests nuevos o preguntas nuevas en tests ya existentes). No toca las tarjetas existentes,
// salvo para rellenar su "categoria" si aún no la tenían.
// Devuelve { anadidas, testsNuevos, omitidas, categorizadas, totalMazo, sincronizado }; "omitidas" = preguntas sin "correcta" numérica.
async function sincronizarNuevosTestsAlMazo() {
  const cargas = await descargarTodosLosTests();

  // Se lee el progreso DESPUÉS de las descargas para no pisar cambios hechos mientras tanto
  const progreso = obtenerProgreso();
  if (!progreso._tarjetas || typeof progreso._tarjetas !== "object") progreso._tarjetas = {};
  if (!progreso._meta || typeof progreso._meta !== "object") progreso._meta = {};

  const r = incorporarPreguntasAlMazo(progreso, cargas, hoyISO());

  const marcarInicializado = Object.keys(progreso._tarjetas).length > 0 && !progreso._meta.ankiInicializado;
  if (marcarInicializado) progreso._meta.ankiInicializado = true;

  let sincronizado = true;
  if (r.anadidas > 0 || r.categorizadas > 0 || marcarInicializado) sincronizado = await guardarProgreso(progreso);

  return {
    anadidas: r.anadidas,
    testsNuevos: r.testsNuevos,
    omitidas: r.omitidas,
    categorizadas: r.categorizadas,
    totalMazo: Object.keys(progreso._tarjetas).length,
    sincronizado
  };
}

// Sincronización automática: una vez por pestaña/sesión (el botón del modal la fuerza siempre).
// Además de buscar tests nuevos, completa en silencio la "categoria" de las tarjetas antiguas.
// Solo actúa si el mazo ya existe; si no, lo crea el primer repaso. Devuelve el resultado o null si no hizo nada.
async function sincronizarTestsSiToca() {
  try {
    if (necesitaInicializarMazo()) return null;
    if (sessionStorage.getItem("anki_sync_tests") === "1") return null;
    const resultado = await sincronizarNuevosTestsAlMazo();
    sessionStorage.setItem("anki_sync_tests", "1"); // solo se marca si terminó (si se cierra la página a medias, se reintenta)
    return resultado;
  } catch (err) {
    console.error("Error sincronizando nuevos tests:", err);
    return null;
  }
}

// Vacía el mazo Anki (mantiene resultados de tests, fecha de examen y configuración) y lo vuelve a crear desde data/
async function reiniciarProgresoAnki() {
  const progreso = obtenerProgreso();
  progreso._tarjetas = {};
  if (progreso._meta && typeof progreso._meta === "object") delete progreso._meta.ankiInicializado;
  await guardarProgreso(progreso);
  return await inicializarMazoAnkiDesdeTests();
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

const ANKI_TOPE_TIEMPO_SEG = 60; // tope para estadísticas (ausencias, pausas...)

// Tiempo válido (segundos, con tope y 1 decimal) o null si no es un número utilizable
function normalizarTiempoSeg(tiempoSegundos) {
  const t = Number(tiempoSegundos);
  if (tiempoSegundos === null || tiempoSegundos === undefined || !Number.isFinite(t) || t < 0) return null;
  return Math.round(Math.min(ANKI_TOPE_TIEMPO_SEG, t) * 10) / 10;
}

// Califica una tarjeta ("again" | "hard" | "medium" | "easy"), la guarda y devuelve su nuevo estado.
// El botón elegido manda al 100 % sobre intervalo y madurez: el tiempo solo alimenta estadísticas.
// "acierto" (opcional): si la respuesta fue correcta; sirve para el récord mejorTiempoSeg
// (si no se pasa, se considera acierto todo lo que no sea "again").
function calificarTarjetaAnki(clave, nivelConfianza, tiempoSegundos, acierto) {
  const progreso = obtenerProgreso();
  const tarjeta = progreso._tarjetas && progreso._tarjetas[clave];
  if (!tarjeta) throw new Error(`La tarjeta ${clave} no existe en el mazo`);

  const nueva = calcularNuevoEstadoTarjeta(tarjeta, nivelConfianza, calcularDiasHastaExamen(), hoyISO());

  // Contador total de revisiones de la tarjeta
  const revisionesPrevias = Number(tarjeta.revisiones) || 0;
  nueva.revisiones = revisionesPrevias + 1;

  const t = normalizarTiempoSeg(tiempoSegundos);
  if (t !== null) {
    const mediaPrevia = Number(tarjeta.tiempoMedioSeg);
    // Nº de revisiones con tiempo medido (coincide con "revisiones" mientras todas se hayan cronometrado)
    const nPrevias = Number(tarjeta.nTiempos) || (mediaPrevia > 0 ? revisionesPrevias : 0);

    nueva.ultimoTiempoSeg = t;
    // (tiempoMedioSeg * revisionesPrevias + tiempoActual) / (revisionesPrevias + 1)
    nueva.tiempoMedioSeg = nPrevias > 0 && mediaPrevia > 0
      ? Math.round(((mediaPrevia * nPrevias + t) / (nPrevias + 1)) * 100) / 100
      : t;
    nueva.nTiempos = nPrevias + 1;

    // Récord: menor tiempo con respuesta acertada
    const fueAcierto = acierto === undefined ? nivelConfianza !== "again" : acierto === true;
    if (fueAcierto) {
      const mejorPrevio = Number(tarjeta.mejorTiempoSeg);
      nueva.mejorTiempoSeg = mejorPrevio > 0 ? Math.min(mejorPrevio, t) : t;
    }
  }

  progreso._tarjetas[clave] = nueva;
  guardarProgreso(progreso);
  return nueva;
}

// Registra (en el objeto progreso, sin guardar) las preguntas falladas de un test como "again"
// "preguntas" (opcional): array de preguntas del test, para guardar su categoría en las tarjetas.
function registrarFallosEnMazo(progreso, testId, indicesFallados, preguntas = null) {
  if (!indicesFallados || !indicesFallados.length) return;
  if (!progreso._tarjetas || typeof progreso._tarjetas !== "object") progreso._tarjetas = {};

  const hoy = hoyISO();
  const dias = calcularDiasHastaExamen();
  indicesFallados.forEach((idx) => {
    const clave = claveTarjeta(testId, idx);
    const pregunta = Array.isArray(preguntas) ? preguntas[idx] : null;
    const tarjeta = progreso._tarjetas[clave] || crearTarjeta(testId, idx, hoy, pregunta ? categoriaDePregunta(pregunta) : null);
    if (!tarjeta.categoria && pregunta) tarjeta.categoria = categoriaDePregunta(pregunta);
    progreso._tarjetas[clave] = calcularNuevoEstadoTarjeta(tarjeta, "again", dias, hoy);
  });
}

/* =====================================================================
 *  ESTADÍSTICAS POR CATEGORÍA Y SELECCIÓN VARIADA DE LA COLA
 * ===================================================================== */

// Revisiones de una tarjeta (con estimación para tarjetas antiguas sin el campo "revisiones")
function revisionesDeTarjeta(t) {
  const fallos = Number(t.fallos) || 0;
  const rev = Number(t.revisiones);
  if (rev > 0) return Math.max(rev, fallos);
  return Math.max(fallos + (Number(t.aciertosSeguidos) || 0), fallos, t.madurez !== "nueva" ? 1 : 0);
}

// { "Velocidad": { categoria, tarjetas, fallos, revisiones, tasaFallo }, ... }
// tasaFallo = fallos / max(1, revisiones), acotada a [0, 1]
function calcularEstadisticasCategorias(tarjetas) {
  const lista = Array.isArray(tarjetas) ? tarjetas : Object.values(obtenerTarjetas());
  const stats = {};
  lista.forEach((t) => {
    const nombre = t.categoria || SIN_CATEGORIA;
    if (!stats[nombre]) stats[nombre] = { categoria: nombre, tarjetas: 0, fallos: 0, revisiones: 0, tasaFallo: 0 };
    stats[nombre].tarjetas++;
    stats[nombre].fallos += Number(t.fallos) || 0;
    stats[nombre].revisiones += revisionesDeTarjeta(t);
  });
  Object.values(stats).forEach((c) => {
    c.tasaFallo = Math.min(1, Math.max(0, c.fallos / Math.max(1, c.revisiones)));
  });
  return stats;
}

// Las categorías más flojas según el historial real (mayor tasa de fallo).
// Solo cuentan categorías con datos suficientes (minRevisiones) y al menos un fallo.
function obtenerCategoriasDebiles(max = 3, minRevisiones = 3) {
  return Object.values(calcularEstadisticasCategorias())
    .filter((c) => c.categoria !== SIN_CATEGORIA && c.revisiones >= minRevisiones && c.fallos > 0)
    .sort((a, b) => b.tasaFallo - a.tasaFallo || b.fallos - a.fallos || b.revisiones - a.revisiones)
    .slice(0, max);
}

// Fisher–Yates (modifica y devuelve el array)
function barajarListaAnki(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Baraja evitando (si hay variedad) dos tarjetas seguidas del mismo test
function barajarEvitandoMismoTest(lista, testPrevio = null) {
  const resto = barajarListaAnki([...lista]);
  const salida = [];
  let previo = testPrevio;
  while (resto.length) {
    let idx = resto.findIndex((t) => t.testId !== previo);
    if (idx === -1) idx = 0;
    const [t] = resto.splice(idx, 1);
    salida.push(t);
    previo = t.testId;
  }
  return salida;
}

// Sorteo ponderado SIN reemplazo. peso = pesoBase(t) + 0.25 si es de un test distinto al de la tarjeta anterior.
// maxNuevas limita cuántas tarjetas "nueva" pueden salir (Infinity = sin tope).
function muestrearPonderado(candidatas, cantidad, pesoBase, testPrevio, maxNuevas) {
  const pool = [...candidatas];
  const elegidas = [];
  let previo = testPrevio;
  let nuevasUsadas = 0;

  while (elegidas.length < cantidad && pool.length) {
    const pesos = new Array(pool.length);
    let total = 0;
    for (let i = 0; i < pool.length; i++) {
      const t = pool[i];
      if (t.madurez === "nueva" && nuevasUsadas >= maxNuevas) { pesos[i] = 0; continue; }
      pesos[i] = pesoBase(t) + (t.testId !== previo ? 0.25 : 0);
      total += pesos[i];
    }
    if (total <= 0) break;

    let r = Math.random() * total;
    let k = -1;
    for (let i = 0; i < pool.length; i++) {
      if (pesos[i] <= 0) continue;
      k = i;
      r -= pesos[i];
      if (r <= 0) break;
    }
    const [t] = pool.splice(k, 1);
    elegidas.push(t);
    previo = t.testId;
    if (t.madurez === "nueva") nuevasUsadas++;
  }
  return elegidas;
}

// Cola de repaso de hoy y estadísticas del mazo (respeta obtenerConfigAnki()).
// Construcción (nunca por orden de testId):
//   1) "aprendiendo" vencidas, barajadas evitando repetir test seguido, y los repasos con retraso (siempre entran)
//   2) hasta completar la cuota: sorteo ponderado entre "nueva" y "joven"/"madura" que vencen hoy,
//      con peso = 1 + tasaFalloCategoria * 3 (+0.25 si el test es distinto al de la tarjeta anterior)
function obtenerColaRepasoHoy() {
  const hoy = hoyISO();
  const diasRestantes = calcularDiasHastaExamen();
  const config = obtenerConfigAnki();
  const entradas = Object.entries(obtenerTarjetas()).map(([clave, t]) => ({ clave, ...t }));

  const porMadurez = { nueva: 0, aprendiendo: 0, joven: 0, madura: 0 };
  entradas.forEach((t) => {
    if (porMadurez[t.madurez] !== undefined) porMadurez[t.madurez]++;
  });

  const noMaduras = entradas.filter((t) => t.madurez !== "madura");
  const cuotaBase = Math.ceil(noMaduras.length / Math.max(1, diasRestantes));

  const estadisticas = calcularEstadisticasCategorias(entradas);
  const pesoBase = (t) => {
    const c = estadisticas[t.categoria || SIN_CATEGORIA];
    return 1 + (c ? c.tasaFallo : 0) * 3;
  };

  const vencidasNoNuevas = entradas.filter((t) => t.madurez !== "nueva" && t.proximaRevision <= hoy);
  const aprendiendo = vencidasNoNuevas.filter((t) => t.madurez === "aprendiendo");
  // Repasos (joven/madura) con retraso: entran siempre para que ninguna tarjeta quede sin revisar indefinidamente
  const repasosConRetraso = vencidasNoNuevas.filter((t) => t.madurez !== "aprendiendo" && t.proximaRevision < hoy);
  const repasosDeHoy = vencidasNoNuevas.filter((t) => t.madurez !== "aprendiendo" && t.proximaRevision >= hoy);
  const nuevas = entradas.filter((t) => t.madurez === "nueva" && t.proximaRevision <= hoy);

  const introducidasHoy = entradas.filter((t) => t.introducida === hoy);
  const forzadasAntiguas = [...aprendiendo, ...repasosConRetraso].filter((t) => t.introducida !== hoy);
  // Tarjetas ya terminadas hoy (revisadas y programadas para otro día)
  const hechasHoy = entradas.filter((t) => t.ultimaRevision === hoy && t.proximaRevision > hoy).length;

  // Tope de nuevas al día (0 = sin tope); las ya introducidas hoy cuentan
  const maxNuevas = config.limiteNuevas > 0
    ? Math.max(0, config.limiteNuevas - introducidasHoy.length)
    : Infinity;

  // Huecos que quedan en la cuota para el sorteo ponderado
  let huecos;
  if (config.modoLimite === "ilimitado") {
    huecos = Infinity;
  } else {
    const objetivo = config.modoLimite === "personalizado" ? config.limiteDiario : cuotaBase;
    huecos = Math.max(0, objetivo - forzadasAntiguas.length - introducidasHoy.length);
  }

  // 1) Urgentes primero, variados entre tests
  const aprendiendoOrd = barajarEvitandoMismoTest(aprendiendo);
  const testTrasAprendiendo = aprendiendoOrd.length ? aprendiendoOrd[aprendiendoOrd.length - 1].testId : null;
  const retrasoOrd = barajarEvitandoMismoTest(repasosConRetraso, testTrasAprendiendo);
  const ultimaForzada = retrasoOrd.length ? retrasoOrd[retrasoOrd.length - 1] : aprendiendoOrd[aprendiendoOrd.length - 1];

  // 2) Sorteo ponderado por debilidad de categoría entre nuevas y repasos de hoy
  const elegidas = muestrearPonderado(
    [...nuevas, ...repasosDeHoy],
    huecos,
    pesoBase,
    ultimaForzada ? ultimaForzada.testId : null,
    maxNuevas
  );

  let colaHoy = [...aprendiendoOrd, ...retrasoOrd, ...elegidas];

  if (config.orden === "aleatorio") {
    colaHoy = barajarEvitandoMismoTest(colaHoy);
  } else if (config.orden === "nuevas_primero") {
    // reparto estable: nuevas → aprendiendo → resto (se conserva la variedad dentro de cada bloque)
    const rango = (t) => (t.madurez === "nueva" ? 0 : t.madurez === "aprendiendo" ? 1 : 2);
    colaHoy = colaHoy.map((t, i) => ({ t, i })).sort((a, b) => rango(a.t) - rango(b.t) || a.i - b.i).map((x) => x.t);
  }

  // Personalizado + límite estricto: se corta exactamente en el límite (descontando lo ya hecho hoy)
  if (config.modoLimite === "personalizado" && config.limiteEstricto) {
    colaHoy = colaHoy.slice(0, Math.max(0, config.limiteDiario - hechasHoy));
  }

  return {
    totalMazo: entradas.length,
    nuevas: porMadurez.nueva,
    aprendiendo: porMadurez.aprendiendo,
    jovenes: porMadurez.joven,
    maduras: porMadurez.madura,
    cuotaDiaria: colaHoy.length, // tarjetas pendientes hoy
    cuotaBase,                   // ritmo diario teórico: ceil(no maduras / días hasta el examen)
    diasRestantes,
    modoLimite: config.modoLimite,
    colaHoy
  };
}

/* ===================================================================== */

// Guarda el resultado de un test individual (para cuando acabes un test).
// indicesFallados (opcional): índices 0-based de las preguntas falladas; pasan al mazo Anki como "again".
// Devuelve true si todo quedó guardado también en la nube.
// preguntas (opcional): array de preguntas del test para guardar su categoría en el mazo.
async function guardarResultadoTest(claveTest, aciertos, fallos, total = 30, indicesFallados = null, preguntas = null) {
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
  if (Number.isFinite(testId)) registrarFallosEnMazo(progreso, testId, indicesFallados, preguntas);

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

// Borra los resultados de los tests y el mazo Anki, manteniendo la fecha de examen (_meta) y las correcciones
async function borrarProgreso() {
  const actual = obtenerProgreso();
  const nuevoEstado = {};
  if (actual._meta) {
    const meta = { ...actual._meta };
    delete meta.ankiInicializado;
    nuevoEstado._meta = meta;
  }
  if (actual._parchesPreguntas && typeof actual._parchesPreguntas === "object") {
    nuevoEstado._parchesPreguntas = actual._parchesPreguntas;
  }
  await guardarProgreso(nuevoEstado);
}
