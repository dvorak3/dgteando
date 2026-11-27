/**
 * @module
 * @remarks
 * Persistencia local y remota del progreso, las correcciones y el mazo Anki.
 * Este módulo expone funciones compartidas con index.js y test_engine.js.
 */

/**
 * @typedef {Object} PreguntaDatos Pregunta de un archivo data/test_XXX.json.
 * @property {string} [texto] Enunciado.
 * @property {string[]} [opciones] Respuestas disponibles.
 * @property {number} [correcta] Índice de la respuesta válida.
 * @property {string} [categoria] Categoría explícita.
 * @property {string} [imagen] Ruta de imagen.
 */

/**
 * @typedef {Object} ParchePregunta Corrección local pendiente o enviada a Supabase.
 * @property {number} testId Número del test.
 * @property {number} preguntaIdx Índice de la pregunta desde cero.
 * @property {string} enunciado Enunciado corregido.
 * @property {string[]} opciones Opciones corregidas.
 * @property {number} correcta Índice correcto.
 * @property {boolean} esNueva Si el parche añade una pregunta.
 * @property {string} [explicacion] Explicación revisada.
 * @property {string} [nota] Motivo de la corrección.
 * @property {string} [imagen] URL pública de una imagen.
 * @property {string} [imagenStoragePath] Ruta de la imagen en Storage.
 * @property {string} [creadoEn] Fecha de creación ISO.
 * @property {string} [actualizadoEn] Última actualización ISO.
 * @property {boolean} [sincronizado] Si se confirmó la persistencia en la nube.
 */

/**
 * @typedef {Object} TarjetaAnki Estado de repetición de una pregunta.
 * @property {number} testId Test de origen.
 * @property {number} preguntaIdx Índice de pregunta desde cero.
 * @property {'nueva'|'aprendiendo'|'joven'|'madura'} madurez Nivel actual.
 * @property {number} fallos Número acumulado de fallos.
 * @property {number} aciertosSeguidos Número de aciertos consecutivos.
 * @property {number} intervaloDias Intervalo actual en días.
 * @property {string} proximaRevision Fecha ISO de próxima revisión.
 * @property {string} [categoria] Categoría DGT.
 */

/**
 * Progreso serializable guardado en localStorage y sincronizado como JSON en Supabase.
 * @typedef {Object<string, *>} ProgresoUsuario
 */

import { clasificarCategoriaDGT } from "./categorias.js";

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

/**
 * Lee y decodifica el progreso guardado localmente.
 * @returns {ProgresoUsuario} Progreso local o un objeto vacío si no existe o no se puede leer.
 */
function obtenerProgreso() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

/**
 * Persiste el progreso local de inmediato y encola una subida ordenada a Supabase.
 * @param {ProgresoUsuario} progreso Estado completo a guardar.
 * @returns {Promise<boolean>} true si Supabase confirmó la escritura.
 */
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

/**
 * Devuelve la promesa de la última escritura remota encolada.
 * @returns {Promise<boolean>} Resultado de la última sincronización.
 */
function esperarGuardadoProgreso() {
  return ultimaOperacionGuardarProgreso;
}

/**
 * Descarga el progreso remoto y lo fusiona con los parches locales más recientes.
 * @returns {Promise<ProgresoUsuario>} Progreso remoto fusionado o el local si falla la lectura.
 */
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

/**
 * Obtiene la fecha de examen configurada, validándola como AAAA-MM-DD.
 * @returns {string} Fecha ISO guardada o la fecha por defecto.
 */
function obtenerFechaExamen() {
  const progreso = obtenerProgreso();
  if (progreso._meta && typeof progreso._meta.fechaExamen === "string" && /^\d{4}-\d{2}-\d{2}$/.test(progreso._meta.fechaExamen)) {
    return progreso._meta.fechaExamen;
  }
  return FECHA_EXAMEN_DEFECTO;
}

/**
 * Actualiza la fecha de examen en los metadatos y sincroniza el progreso.
 * @param {string} nuevaFechaISO Fecha de examen con formato AAAA-MM-DD.
 * @returns {Promise<void>}
 */
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

/**
 * Valida y completa una configuración Anki usando los valores predeterminados.
 * @param {*} cruda Configuración posiblemente incompleta o corrupta.
 * @returns {Object} Configuración normalizada para el mazo.
 */
function normalizarConfigAnki(cruda) {
  const c = cruda && typeof cruda === "object" ? cruda : {};
  const D = ANKI_CONFIG_DEFECTO;
  /**
   * Normaliza un valor entero acotándolo al rango permitido.
   * @param {*} v Valor de entrada.
   * @param {number} def Valor por defecto.
   * @param {number} min Límite inferior.
   * @param {number} max Límite superior.
   * @returns {number} Valor entero validado.
   */
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

/**
 * Lee la configuración del mazo y devuelve su forma normalizada.
 * @returns {Object} Configuración Anki válida.
 */
function obtenerConfigAnki() {
  const progreso = obtenerProgreso();
  const guardada = progreso._meta && typeof progreso._meta === "object" ? progreso._meta.ankiConfig : null;
  return normalizarConfigAnki(guardada);
}

/**
 * Fusiona y guarda la configuración Anki en los metadatos y la sincroniza.
 * @param {Object} nuevaConfig Valores de configuración a actualizar.
 * @returns {Promise<boolean>} true si se guardó también en la nube.
 */
async function guardarConfigAnki(nuevaConfig) {
  const progreso = obtenerProgreso();
  if (!progreso._meta || typeof progreso._meta !== "object") progreso._meta = {};
  progreso._meta.ankiConfig = normalizarConfigAnki({ ...obtenerConfigAnki(), ...(nuevaConfig || {}) });
  return await guardarProgreso(progreso);
}

/**
 * Calcula la racha diaria actual a partir de los intentos guardados.
 * @returns {{dias: number, practicoHoy: boolean}} Longitud de la racha y actividad de hoy.
 */
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

  /**
   * Formatea una fecha local como clave DD/MM/AAAA para comparar días de actividad.
   * @param {Date} dateObj Fecha local.
   * @returns {string} Fecha normalizada.
   */
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
/**
 * Formatea una fecha local como AAAA-MM-DD sin convertirla a UTC.
 * @param {Date} d Fecha local.
 * @returns {string} Fecha ISO local.
 */
function fechaISOLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dia}`;
}

/**
 * Obtiene la fecha local actual con formato AAAA-MM-DD.
 * @returns {string} Fecha actual.
 */
function hoyISO() {
  return fechaISOLocal(new Date());
}

/**
 * Suma días de calendario a una fecha ISO.
 * @param {string} iso Fecha inicial AAAA-MM-DD.
 * @param {number} dias Cantidad de días que sumar.
 * @returns {string} Nueva fecha AAAA-MM-DD.
 */
function sumarDiasISO(iso, dias) {
  const [y, m, d] = iso.split("-").map(Number);
  return fechaISOLocal(new Date(y, m - 1, d + dias));
}

// Días de "desde" a "hasta" (ambas "YYYY-MM-DD"); negativo si hasta es anterior
/**
 * Calcula la diferencia entre dos fechas ISO en días de calendario.
 * @param {string} desde Fecha inicial.
 * @param {string} hasta Fecha final.
 * @returns {number} Días de diferencia; puede ser negativo.
 */
function diasEntreISO(desde, hasta) {
  const [y1, m1, d1] = desde.split("-").map(Number);
  const [y2, m2, d2] = hasta.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// Días que faltan para el examen (mínimo 1)
/**
 * Calcula los días restantes hasta el examen, con mínimo de un día.
 * @returns {number} Días restantes.
 */
function calcularDiasHastaExamen() {
  return Math.max(1, diasEntreISO(hoyISO(), obtenerFechaExamen()));
}

// Carga data/test_XXX.json (con fallback sin cero inicial: test_73.json). Devuelve null si no existe.
/**
 * Descarga un test probando nombres con y sin ceros iniciales.
 * @param {number|string} n Número identificador del test.
 * @returns {Promise<*|null>} JSON del test o null si no se pudo cargar.
 */
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

/**
 * Extrae el array de preguntas tanto de JSON en array como de objetos con propiedad preguntas.
 * @param {*} data JSON decodificado del test.
 * @returns {PreguntaDatos[]|null} Preguntas del test o null si la forma no es válida.
 */
function preguntasDeDatosTest(data) {
  if (Array.isArray(data)) return data;
  return data && Array.isArray(data.preguntas) ? data.preguntas : null;
}

// Clave de tarjeta: "070_04" = test 70, pregunta nº 4 (preguntaIdx 3)
/**
 * Construye la clave estable de una tarjeta a partir de sus índices.
 * @param {number|string} testId Identificador del test.
 * @param {number} preguntaIdx Índice de pregunta desde cero.
 * @returns {string} Clave normalizada, por ejemplo 070_04.
 */
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

/**
 * Valida y normaliza una corrección procedente del almacenamiento local o remoto.
 * @param {*} crudo Datos sin validar.
 * @returns {ParchePregunta|null} Parche normalizado o null si el contenido es inválido.
 */
function normalizarParchePregunta(crudo) {
  if (!crudo || typeof crudo !== "object") return null;
  /**
   * Convierte un valor textual a cadena recortada o a cadena vacía.
   * @param {*} valor Valor que se normaliza.
   * @returns {string} Texto limpio.
   */
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

/**
 * Devuelve los parches locales válidos indexados por clave de tarjeta.
 * @returns {Object<string, ParchePregunta>} Mapa de preguntas corregidas.
 */
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

/**
 * Obtiene el parche local de una pregunta concreta.
 * @param {number} testId Número del test.
 * @param {number} preguntaIdx Índice de pregunta desde cero.
 * @returns {ParchePregunta|null} Parche normalizado, si existe.
 */
function obtenerParchePregunta(testId, preguntaIdx) {
  const crudos = obtenerProgreso()._parchesPreguntas;
  if (!crudos || typeof crudos !== "object") return null;
  return normalizarParchePregunta(crudos[claveTarjeta(testId, preguntaIdx)]);
}

/**
 * Fusiona los parches locales que sean más recientes que sus equivalentes de la nube.
 * @param {ProgresoUsuario} datosNube Progreso descargado para mutar y devolver.
 * @returns {ProgresoUsuario} Progreso con parches locales preservados.
 */
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

/**
 * Convierte un parche normalizado en la fila que acepta la tabla flags_preguntas.
 * @param {ParchePregunta} parche Corrección a serializar.
 * @param {string} userId ID del usuario autenticado.
 * @returns {Object} Fila Supabase con nombres de columna de la tabla.
 */
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

/**
 * Genera un UUID v4 para identificar de forma idempotente un lote de flags.
 * @returns {string} Identificador UUID.
 */
function nuevoIdLoteFlags() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Lee y valida la cola de flags desde memoria o localStorage.
 * @returns {{id: string, flags: ParchePregunta[]}|null} Lote pendiente o null si está vacío.
 * @throws {Error} Si la cola persistida tiene formato inválido.
 */
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

/**
 * Actualiza la cola en memoria y la persiste o elimina de localStorage.
 * @param {{id: string, flags: ParchePregunta[]}|null} cola Cola pendiente o null para vaciarla.
 * @returns {void}
 */
function guardarColaFlagsSesion(cola) {
  colaFlagsSesionMemoria = cola;
  if (cola) localStorage.setItem(FLAGS_COLA_KEY, JSON.stringify(cola));
  else localStorage.removeItem(FLAGS_COLA_KEY);
}

/**
 * Añade o reemplaza una corrección en el lote activo de la sesión.
 * @param {*} payload Datos de la corrección que se validarán.
 * @returns {string} ID del lote que contiene la corrección.
 * @throws {Error} Si los datos no forman un parche válido.
 */
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

/**
 * Obtiene la sesión Supabase activa sin crear una nueva.
 * @returns {Promise<Object|null>} Sesión autenticada o null.
 * @throws {Error} Si Supabase devuelve un error.
 */
async function obtenerSesionExistente() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  return data && data.session ? data.session : null;
}

/**
 * Reutiliza una sesión existente o crea una sesión anónima para sincronizar flags.
 * @returns {Promise<Object>} Sesión Supabase con usuario.
 * @throws {Error} Si no se puede crear u obtener una sesión válida.
 */
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

/**
 * Comparte la promesa de preparación de sesión para evitar inicios simultáneos.
 * @returns {Promise<Object>} Sesión autenticada que se utilizará para los flags.
 */
function prepararSesionFlags() {
  if (!sesionFlagsPromise) {
    sesionFlagsPromise = iniciarSesionAnonimaSiHaceFalta();
  }
  const tarea = sesionFlagsPromise;
  return tarea.finally(() => {
    if (sesionFlagsPromise === tarea) sesionFlagsPromise = null;
  });
}

/**
 * Persiste un parche de pregunta en la propiedad _parchesPreguntas de localStorage.
 * @param {ParchePregunta} parche Corrección ya normalizada.
 * @returns {void}
 */
function guardarParcheLocal(parche) {
  const progreso = obtenerProgreso();
  if (!progreso._parchesPreguntas || typeof progreso._parchesPreguntas !== "object") {
    progreso._parchesPreguntas = {};
  }
  const clave = claveTarjeta(parche.testId, parche.preguntaIdx);
  progreso._parchesPreguntas[clave] = parche;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progreso));
}

/**
 * Guarda una corrección local, la añade al lote de sesión y opcionalmente sube su imagen.
 * @param {Object} payload Datos de la corrección, incluyendo imagenArchivo opcional.
 * @returns {Object|Promise<Object>} Resultado local inmediato o promesa si se sube una imagen.
 * @throws {Error} Si la corrección o la imagen no es válida.
 * @mermaid
 * ```mermaid
 * sequenceDiagram
 *   participant UI as Modal de corrección
 *   participant Local as localStorage
 *   participant Queue as Cola de sesión
 *   participant Auth as Supabase Auth
 *   UI->>Local: validar y guardar parche
 *   Local->>Queue: encolar corrección
 *   opt Imagen adjunta
 *     Queue->>Auth: preparar sesión
 *     Auth-->>Queue: sesión anónima o existente
 *     Queue->>Queue: subir imagen a Storage
 *   end
 *   Queue-->>UI: parche guardado localmente
 * ```
 */
function guardarFlagPregunta(payload) {
  const base = normalizarParchePregunta(payload);
  if (!base) {
    throw new Error("Corrección no válida: revisa el enunciado, las opciones (2 o 3) y la respuesta correcta.");
  }
  /**
   * Completa el guardado local con la URL de imagen si se subió.
   * @param {{url: string, path: string}|null} [imagenSubida=null] Datos de imagen remota.
   * @returns {{ok: true, parche: ParchePregunta, nube: string, loteId: string}} Resultado guardado.
   */
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

/**
 * Envía filas y marcador de lote con fetch keepalive para cierres de página.
 * @param {Object[]} filas Filas de flags_preguntas.
 * @param {Object} marcador Registro idempotente del lote.
 * @param {string} accessToken Token de sesión Supabase.
 * @returns {Promise<void>}
 * @throws {Error} Si cualquiera de las peticiones HTTP falla.
 */
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

/**
 * Inicia una sola sincronización concurrente del lote activo de flags.
 * @param {{keepalive?: boolean}} [opciones] Usa fetch keepalive para beforeunload.
 * @returns {Promise<{ok: boolean, enviados: number, sinCambios?: boolean, loteId?: string}>} Resultado.
 * @mermaid
 * ```mermaid
 * flowchart TD
 *   A[Solicitar sincronización] --> B{¿Hay una petición en curso?}
 *   B -- Sí --> C[Reutilizar promesa activa]
 *   B -- No --> D[Ejecutar envío del lote]
 *   D --> E[Upsert de flags y marcador]
 *   E --> F[Marcar parches locales sincronizados]
 *   F --> G[Retirar solo las correcciones enviadas]
 * ```
 */
function sincronizarFlagsSesion({ keepalive = false } = {}) {
  if (sincronizacionFlagsEnCurso) return sincronizacionFlagsEnCurso;
  const tarea = ejecutarSincronizacionFlagsSesion(keepalive);
  sincronizacionFlagsEnCurso = tarea;
  return tarea.finally(() => {
    if (sincronizacionFlagsEnCurso === tarea) sincronizacionFlagsEnCurso = null;
  });
}

/**
 * Sube el lote completo, marca sus parches sincronizados y conserva cambios nuevos concurrentes.
 * @param {boolean} keepalive Indica si la página se está cerrando.
 * @returns {Promise<{ok: boolean, enviados: number, sinCambios?: boolean, loteId?: string}>} Resultado.
 * @throws {Error} Si no hay sesión o Supabase rechaza la sincronización.
 */
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
/**
 * Obtiene la categoría explícita o calculada de una pregunta.
 * @param {PreguntaDatos} pregunta Pregunta de origen.
 * @returns {string} Categoría clasificada o valor de respaldo.
 */
function categoriaDePregunta(pregunta) {
  if (!pregunta || typeof pregunta !== "object") return CATEGORIA_FALLBACK;
  const explicita = typeof pregunta.categoria === "string" ? pregunta.categoria.trim() : "";
  if (typeof clasificarCategoriaDGT === "function") {
    return clasificarCategoriaDGT(pregunta.texto, explicita, pregunta.opciones);
  }
  return explicita || CATEGORIA_FALLBACK;
}

/**
 * Crea el estado inicial de una tarjeta Anki.
 * @param {number|string} testId Test de origen.
 * @param {number} preguntaIdx Índice de pregunta desde cero.
 * @param {string} [hoy] Fecha ISO que se usará como próxima revisión.
 * @param {?string} [categoria] Categoría opcional.
 * @returns {TarjetaAnki} Tarjeta nueva, aún no estudiada.
 */
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

/**
 * Devuelve el mapa de tarjetas Anki guardado en el progreso.
 * @returns {Object<string, TarjetaAnki>} Tarjetas indexadas por clave.
 */
function obtenerTarjetas() {
  const progreso = obtenerProgreso();
  return progreso._tarjetas && typeof progreso._tarjetas === "object" ? progreso._tarjetas : {};
}

// True si hay que (re)cargar el mazo desde los tests: no hay tarjetas o nunca se inicializó
/**
 * Indica si el mazo debe inicializarse o reconstruirse desde los tests disponibles.
 * @returns {boolean} true si faltan tarjetas o el indicador de inicialización.
 */
function necesitaInicializarMazo() {
  const progreso = obtenerProgreso();
  const hayTarjetas = progreso._tarjetas && Object.keys(progreso._tarjetas).length > 0;
  const inicializado = Boolean(progreso._meta && progreso._meta.ankiInicializado);
  return !hayTarjetas || !inicializado;
}

// Descarga en paralelo todos los tests de data/ (1..ANKI_MAX_TEST)
/**
 * Descarga en paralelo los tests configurados para alimentar el mazo.
 * @returns {Promise<Array<{n: number, data: *}>>} Pares de ID de test y contenido descargado.
 */
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
/**
 * Añade tarjetas ausentes y completa categorías sin cambiar su historial de estudio.
 * @param {ProgresoUsuario} progreso Estado que se modifica en memoria.
 * @param {Array<{n: number, data: *}>} cargas Tests descargados.
 * @param {string} hoy Fecha de referencia AAAA-MM-DD.
 * @returns {{testsCargados: number, anadidas: number, testsNuevos: number, omitidas: number, categorizadas: number}} Resumen de cambios.
 */
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
/**
 * Inicializa el mazo con todas las preguntas que incluyen respuesta correcta.
 * @returns {Promise<{testsCargados: number, anadidas: number, categorizadas: number, totalMazo: number}>} Resumen.
 */
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
/**
 * Busca tests y preguntas nuevas y las incorpora sin reiniciar tarjetas existentes.
 * @returns {Promise<{anadidas: number, testsNuevos: number, omitidas: number, categorizadas: number, totalMazo: number, sincronizado: boolean}>} Resumen de incorporación.
 */
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
/**
 * Sincroniza los tests nuevos como máximo una vez por pestaña, omitiendo fallos reintentables.
 * @returns {Promise<Object|null>} Resumen de sincronización o null si no se ejecutó.
 */
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
/**
 * Borra el estado del mazo y lo inicializa de nuevo con los datos actuales.
 * @returns {Promise<Object>} Resumen del mazo recién creado.
 */
async function reiniciarProgresoAnki() {
  const progreso = obtenerProgreso();
  progreso._tarjetas = {};
  if (progreso._meta && typeof progreso._meta === "object") delete progreso._meta.ankiInicializado;
  await guardarProgreso(progreso);
  return await inicializarMazoAnkiDesdeTests();
}

// Intervalo en días según confianza, acotado para no programar más allá del examen
/**
 * Calcula el intervalo nominal para una calificación antes de limitarlo al examen.
 * @param {'hard'|'medium'|'easy'|'again'} nivel Nivel de confianza.
 * @param {number} diasRestantes Días que faltan para el examen.
 * @returns {number} Intervalo nominal en días.
 */
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
/**
 * Calcula el próximo estado de una tarjeta sin mutar el objeto original.
 * @param {TarjetaAnki} tarjeta Estado actual.
 * @param {'again'|'hard'|'medium'|'easy'} nivelConfianza Calificación elegida.
 * @param {number} diasRestantes Días que faltan para el examen.
 * @param {string} hoy Fecha de referencia AAAA-MM-DD.
 * @returns {TarjetaAnki} Copia actualizada de la tarjeta.
 * @throws {Error} Si el nivel de confianza no está admitido.
 */
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
/**
 * Calcula los intervalos que mostrarían los botones de confianza para una tarjeta.
 * @param {string} clave Clave de tarjeta.
 * @returns {Object<string, number>|null} Intervalos por nivel o null si no existe.
 */
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
/**
 * Valida y limita un tiempo de respuesta para estadísticas.
 * @param {*} tiempoSegundos Valor recibido.
 * @returns {?number} Tiempo normalizado o null si no es utilizable.
 */
function normalizarTiempoSeg(tiempoSegundos) {
  const t = Number(tiempoSegundos);
  if (tiempoSegundos === null || tiempoSegundos === undefined || !Number.isFinite(t) || t < 0) return null;
  return Math.round(Math.min(ANKI_TOPE_TIEMPO_SEG, t) * 10) / 10;
}

// Califica una tarjeta ("again" | "hard" | "medium" | "easy"), la guarda y devuelve su nuevo estado.
// El botón elegido manda al 100 % sobre intervalo y madurez: el tiempo solo alimenta estadísticas.
// "acierto" (opcional): si la respuesta fue correcta; sirve para el récord mejorTiempoSeg
// (si no se pasa, se considera acierto todo lo que no sea "again").
/**
 * Aplica la calificación Anki, actualiza sus estadísticas y encola el guardado del progreso.
 * @param {string} clave Clave de tarjeta.
 * @param {'again'|'hard'|'medium'|'easy'} nivelConfianza Nivel elegido.
 * @param {*} tiempoSegundos Duración de la respuesta en segundos.
 * @param {boolean} [acierto] Si la respuesta fue correcta, para el récord de tiempo.
 * @returns {TarjetaAnki} Estado actualizado.
 * @throws {Error} Si la tarjeta no existe o el nivel no es válido.
 */
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
/**
 * Marca como «again» las preguntas falladas de un test dentro del progreso en memoria.
 * @param {ProgresoUsuario} progreso Progreso que se modifica sin persistir.
 * @param {number} testId Identificador del test.
 * @param {number[]} indicesFallados Índices de preguntas falladas desde cero.
 * @param {PreguntaDatos[]|null} [preguntas] Preguntas para asignar la categoría.
 * @returns {void}
 */
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
/**
 * Obtiene el número de revisiones, estimándolo para tarjetas de versiones antiguas.
 * @param {TarjetaAnki} t Tarjeta que se consulta.
 * @returns {number} Revisiones estimadas o almacenadas.
 */
function revisionesDeTarjeta(t) {
  const fallos = Number(t.fallos) || 0;
  const rev = Number(t.revisiones);
  if (rev > 0) return Math.max(rev, fallos);
  return Math.max(fallos + (Number(t.aciertosSeguidos) || 0), fallos, t.madurez !== "nueva" ? 1 : 0);
}

// { "Velocidad": { categoria, tarjetas, fallos, revisiones, tasaFallo }, ... }
// tasaFallo = fallos / max(1, revisiones), acotada a [0, 1]
/**
 * Agrupa fallos, tarjetas y revisiones por categoría.
 * @param {TarjetaAnki[]|null} tarjetas Lista opcional; por defecto usa todo el mazo.
 * @returns {Object<string, {categoria: string, tarjetas: number, fallos: number, revisiones: number, tasaFallo: number}>} Estadísticas por categoría.
 */
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
/**
 * Devuelve las categorías con mayor tasa de fallos que cumplen el mínimo de datos.
 * @param {number} [max=3] Cantidad máxima de categorías.
 * @param {number} [minRevisiones=3] Revisiones mínimas para incluir una categoría.
 * @returns {Array<{categoria: string, tarjetas: number, fallos: number, revisiones: number, tasaFallo: number}>} Categorías ordenadas por debilidad.
 */
function obtenerCategoriasDebiles(max = 3, minRevisiones = 3) {
  return Object.values(calcularEstadisticasCategorias())
    .filter((c) => c.categoria !== SIN_CATEGORIA && c.revisiones >= minRevisiones && c.fallos > 0)
    .sort((a, b) => b.tasaFallo - a.tasaFallo || b.fallos - a.fallos || b.revisiones - a.revisiones)
    .slice(0, max);
}

// Fisher–Yates (modifica y devuelve el array)
/**
 * Baraja una lista in situ mediante Fisher–Yates.
 * @template T
 * @param {T[]} arr Elementos que se mezclarán.
 * @returns {T[]} La misma lista ya barajada.
 */
function barajarListaAnki(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Baraja evitando (si hay variedad) dos tarjetas seguidas del mismo test
/**
 * Baraja tarjetas procurando alternar tests consecutivos cuando hay variedad.
 * @param {TarjetaAnki[]} lista Tarjetas a ordenar.
 * @param {?number} [testPrevio=null] Test de la tarjeta anterior a la secuencia.
 * @returns {TarjetaAnki[]} Copia barajada con variedad de tests.
 */
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
/**
 * Selecciona tarjetas aleatoriamente sin reemplazo, ponderando cada candidata.
 * @param {TarjetaAnki[]} candidatas Tarjetas candidatas.
 * @param {number} cantidad Máximo de tarjetas que seleccionar.
 * @param {(tarjeta: TarjetaAnki) => number} pesoBase Peso específico de cada tarjeta.
 * @param {?number} testPrevio Test de la última tarjeta anterior a la muestra.
 * @param {number} maxNuevas Máximo de tarjetas nuevas; Infinity no limita.
 * @returns {TarjetaAnki[]} Tarjetas elegidas.
 */
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
/**
 * Construye la cola de hoy considerando vencimientos, configuración, cuotas y categorías débiles.
 * @returns {Object} Cola de tarjetas y resumen de madurez, cuota y días hasta el examen.
 * @mermaid
 * ```mermaid
 * flowchart TD
 *   A[Leer mazo y configuración] --> B[Separar vencidas y nuevas]
 *   B --> C[Incluir tarjetas urgentes]
 *   C --> D[Muestrear por categoría y prioridad]
 *   D --> E[Aplicar orden y límite diario]
 *   E --> F[Devolver cola y estadísticas]
 * ```
 */
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
  /**
   * Asigna mayor peso a tarjetas de categorías con una tasa de fallos más alta.
   * @param {TarjetaAnki} t Tarjeta candidata.
   * @returns {number} Peso base para el muestreo ponderado.
   */
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
    /**
     * Define el orden de los grupos de madurez en el modo nuevas primero.
     * @param {TarjetaAnki} t Tarjeta evaluada.
     * @returns {number} Prioridad de orden.
     */
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
/**
 * Guarda el resultado de un test, agrega historial y registra sus fallos en el mazo.
 * @param {string} claveTest Clave del test en progreso, por ejemplo test_070.
 * @param {number} aciertos Cantidad de respuestas correctas.
 * @param {number} fallos Cantidad de respuestas incorrectas.
 * @param {number} [total=30] Preguntas totales.
 * @param {number[]|null} [indicesFallados=null] Índices 0-based de preguntas incorrectas.
 * @param {PreguntaDatos[]|null} [preguntas=null] Preguntas para registrar su categoría.
 * @returns {Promise<boolean>} true si se sincronizó con Supabase.
 */
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
/**
 * Obtiene el historial de intentos, convirtiendo el formato antiguo cuando sea necesario.
 * @param {string} claveTest Clave del test.
 * @returns {Array<{fecha: string, fallos: number}>} Historial de fallos.
 */
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
/**
 * Descarga un archivo JSON con el progreso local completo.
 * @returns {void}
 */
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
/**
 * Lee un archivo JSON de progreso, lo guarda y ejecuta el callback de refresco.
 * @param {File} archivo Archivo JSON elegido por el usuario.
 * @param {() => void} [callback] Callback tras guardar correctamente.
 * @returns {void}
 */
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
/**
 * Borra resultados y tarjetas conservando metadatos y correcciones de preguntas.
 * @returns {Promise<void>}
 */
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

export {
  ultimaSincronizacionOk,
  obtenerProgreso,
  guardarProgreso,
  esperarGuardadoProgreso,
  sincronizarDesdeNube,
  obtenerFechaExamen,
  guardarFechaExamen,
  normalizarConfigAnki,
  obtenerConfigAnki,
  guardarConfigAnki,
  calcularRachaEstudio,
  fechaISOLocal,
  hoyISO,
  sumarDiasISO,
  diasEntreISO,
  calcularDiasHastaExamen,
  cargarDatosTest,
  preguntasDeDatosTest,
  claveTarjeta,
  normalizarParchePregunta,
  obtenerParchesPreguntas,
  obtenerParchePregunta,
  conservarParchesLocalesMasRecientes,
  filaFlagDesdeParche,
  nuevoIdLoteFlags,
  leerColaFlagsSesion,
  guardarColaFlagsSesion,
  encolarFlagSesion,
  obtenerSesionExistente,
  iniciarSesionAnonimaSiHaceFalta,
  prepararSesionFlags,
  guardarParcheLocal,
  guardarFlagPregunta,
  upsertFlagsConKeepalive,
  sincronizarFlagsSesion,
  ejecutarSincronizacionFlagsSesion,
  categoriaDePregunta,
  crearTarjeta,
  obtenerTarjetas,
  necesitaInicializarMazo,
  descargarTodosLosTests,
  incorporarPreguntasAlMazo,
  inicializarMazoAnkiDesdeTests,
  sincronizarNuevosTestsAlMazo,
  sincronizarTestsSiToca,
  reiniciarProgresoAnki,
  intervaloPorConfianza,
  calcularNuevoEstadoTarjeta,
  previsualizarIntervalosTarjeta,
  normalizarTiempoSeg,
  calificarTarjetaAnki,
  registrarFallosEnMazo,
  revisionesDeTarjeta,
  calcularEstadisticasCategorias,
  obtenerCategoriasDebiles,
  barajarListaAnki,
  barajarEvitandoMismoTest,
  muestrearPonderado,
  obtenerColaRepasoHoy,
  guardarResultadoTest,
  obtenerHistorialTest,
  exportarJSON,
  importarJSON,
  borrarProgreso
};
