/* =====================================================================
 *  dgt-eando · categorías DGT
 *  Clasificación automática de preguntas por palabras clave.
 *  Módulo ES: sus funciones y constantes se importan de forma explícita.
 * ===================================================================== */

/**
 * @module
 * @remarks
 * Clasifica preguntas de conducción en categorías mediante
 * patrones de palabras clave normalizados.
 * Expone el catálogo de categorías y los temas disponibles a los módulos
 * que preparan el progreso y renderizan las vistas.
 * @typedef {Object} CategoriaDGT
 * @property {string} nombre Nombre visible de la categoría.
 * @property {RegExp[]} patrones Patrones que permiten reconocerla en un texto.
 */

/** @type {string} Categoría devuelta cuando no hay coincidencias. */
const CATEGORIA_POR_DEFECTO = "Otras normas";

// El orden importa: en caso de empate gana la categoría que aparece antes.
// Los patrones se aplican sobre texto en minúsculas y SIN tildes ni ñ (ver normalizarTextoDGT).
/** @type {CategoriaDGT[]} Catálogo de categorías ordenado por prioridad. */
const CATEGORIAS_DGT = [
  { nombre: "Señales y marcas viales", patrones: [
    /\bsenal(es|izacion|izada|izadas)?\b/, /\bmarcas? viales?\b/, /\blineas? (blanca|amarilla|continua|discontinua|longitudinal|transversal|de detencion)/,
    /\bsemaforos?\b/, /\bpaneles?\b/, /\bagentes?\b/, /\bcebreado/, /\bbaden\b/, /\bresalto/, /\bcarriles? (bus|reversible|especial|vao)/,
    /\bpaso de peatones\b/, /\bdelimit/, /\bbalizamiento/, /\bmarcas? (longitudinales|transversales|blancas|amarillas)/, /\bpictograma/
  ]},
  { nombre: "Velocidad", patrones: [
    /\bvelocidad/, /\bkm\/h\b/, /\bdistancias? de (seguridad|separacion|detencion|frenado|reaccion)/, /\bdistancia\b/, /\bfrenado\b/,
    /\btiempo de reaccion/, /\bradar/, /\bacelera/
  ]},
  { nombre: "Prioridad y cruces", patrones: [
    /\bprioridad/, /\bced(er|a)( el)? paso\b/, /\binterseccion/, /\bcruces?\b/, /\bglorieta/, /\brotonda/, /\bpreferencia/, /\bstop\b/,
    /\bpaso a nivel\b/, /\bbifurcacion/, /\bvehiculos? (prioritario|de servicio)/, /\bpuente estrecho/, /\bestrechamiento/
  ]},
  { nombre: "Maniobras", patrones: [
    /\badelant/, /\bcambio de sentido\b/, /\bmarcha atras\b/, /\bgir(o|a|ar|e|ando)\b/, /\bincorpor/, /\bestacion/, /\bparadas?\b/,
    /\bcambio de (carril|direccion)\b/, /\bcambiar de carril\b/, /\bmaniobra/, /\bcarril\b/, /\bretroceder/, /\bdar la vuelta\b/,
    /\b(entrar|entrada|salir|salida) (en|de) (una |la )?(autopista|autovia)/, /\bsentido contrario\b/, /\bdetenerse\b/, /\bdetencion\b/
  ]},
  { nombre: "Alumbrado y visibilidad", patrones: [
    /\bluz\b/, /\bluces\b/, /\balumbrado/, /\bniebla/, /\bvisibilidad/, /\bdeslumbr/, /\bfaros?\b/, /\bintermitentes?\b/, /\bantiniebla/,
    /\bnoche\b/, /\bnocturn/, /\banochecer|amanecer|puesta de(l)? sol|salida de(l)? sol\b/, /\bchaleco/, /\bcatadioptric/, /\bpilotos?\b/, /\bcondiciones de (luz|visibilidad)/
  ]},
  { nombre: "Alcohol, drogas y fatiga", patrones: [
    /\balcohol/, /\bdrogas?\b/, /\bestupefaciente/, /\bfatiga/, /\bcansancio/, /\bsomnolencia/, /\bsueno\b/, /\bmedicamento/, /\bmedicina/,
    /\bembriaguez/, /\bdescans(o|ar)/, /\balcoholemia/, /\bsustancias\b/, /\bbebidas\b/
  ]},
  { nombre: "Seguridad y sistemas", patrones: [
    /\bcinturon/, /\bcasco\b/, /\bairbag/, /\badas\b/, /\bsistemas? (avanzados|de (retencion|seguridad|ayuda|asistencia|frenado))/, /\bretencion/,
    /\bnin(o|a|os|as)\b/, /\babs\b/, /\besp\b/, /\bestabilidad\b/, /\bposicion\b/, /\bapoyacabezas|reposacabezas/, /\bchanclas|calzado/,
    /\bseguridad (activa|pasiva|vial)/, /\bsubmarino/, /\bdistraccion/, /\bmovil\b/, /\btelefono/, /\bauriculares/, /\bmanos libres\b/,
    /\bconduccion (segura|defensiva)/, /\bsri\b/, /\bvehiculos? (autonomo|conectado)/
  ]},
  { nombre: "Accidentes y primeros auxilios", patrones: [
    /\baccidente/, /\bherid(o|os|a|as)\b/, /\bprimeros auxilios\b/, /\bsocorro/, /\bauxilio/, /\bextintor/, /\bincendio/, /\barder\b/, /\bfuego/,
    /\baveri/, /\bv-?16\b/, /\btriangulos?\b/, /\bpresenaliz/, /\bambulancia/, /\bevacuar/, /\bhemorragia/, /\breanimacion/, /\binmovilizado\b/, /\bp\.?a\.?s\b/
  ]},
  { nombre: "Documentación y normativa", patrones: [
    /\bpermiso/, /\blicencia/, /\bseguro (obligatorio|del vehiculo)/, /\bitv\b/, /\binspeccion tecnica/, /\bdocumentacion/, /\bsancion/, /\bmultas?\b/,
    /\bpuntos? (del|de) (permiso|carnet|conducir)/, /\binfraccion/, /\bmatricula/, /\breglamento|normativa|\bley\b/, /\bautorizacion/,
    /\bdistintivo ambiental/, /\btarjeta\b/, /\bcarne\b|\bcarnet\b/, /\bnovel\b/, /\bautoescuela/, /\bprofesor/, /\balumno/, /\bresponsab/,
    /\bdenuncia/, /\bretirada\b/, /\bzonas? de bajas emisiones\b|\bzbe\b/, /\bvao\b/, /\bantecedentes/
  ]},
  { nombre: "Mecánica y mantenimiento", patrones: [
    /\bneumatic/, /\baceite/, /\bbateria/, /\bmotor\b/, /\bliquido/, /\bfrenos?\b/, /\bamortiguador/, /\brefrigerante/, /\bdesgaste/, /\bpresion\b/,
    /\bcombustible/, /\bconsumo\b/, /\bmantenimiento/, /\bremolque/, /\bespejos?\b/, /\bretrovisor/, /\bparabrisas/, /\bescape\b|\bcatalizador|\bemisiones\b/,
    /\bembrague/, /\bcaja de cambios\b/, /\bsuspension/, /\btestigo/, /\bcadenas\b/, /\bfiltro\b/, /\bcarga\b/, /\bmecanic/
  ]}
];

/**
 * Catálogo público de prácticas por tema. Se pueden añadir temas sin cambiar
 * el motor de repaso; `categoriaMatch` se compara sin distinguir mayúsculas ni tildes.
 * @type {Array<{id: string, titulo: string, descripcion: string, categoriaMatch: string, activo: boolean}>}
 */
const TEMAS_DGT = Object.freeze([
  Object.freeze({
    id: "senales",
    titulo: "Señales",
    descripcion: "Señales verticales, marcas viales, agentes y semáforos.",
    categoriaMatch: "señales",
    activo: true
  })
]);

/**
 * Convierte un valor a texto en minúsculas, elimina diacríticos y normaliza
 * espacios para compararlo con los patrones de categorías.
 * @param {*} texto Valor que se desea normalizar.
 * @returns {string} Texto normalizado.
 */
function normalizarTextoDGT(texto) {
  return String(texto === null || texto === undefined ? "" : texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")            // quita tildes (la ñ pasa a n)
    .replace(/\bluces? de cruce\b/g, "luz corta") // evita confundir "luz de cruce" con "cruce" de calles
    .replace(/\s+/g, " ");
}

/**
 * Normaliza nombres de categoría para comparaciones sin tildes ni diferencias de mayúsculas.
 * @param {*} categoria Nombre de categoría.
 * @returns {string} Nombre normalizado.
 */
function normalizarCategoriaDGT(categoria) {
  return normalizarTextoDGT(categoria).trim();
}

/**
 * Busca un tema activo por su identificador.
 * @param {string} temaId Identificador del tema.
 * @returns {typeof TEMAS_DGT[number]|undefined} Tema encontrado.
 */
function obtenerTemaDGT(temaId) {
  return TEMAS_DGT.find((tema) => tema.id === temaId && tema.activo);
}

// Asigna una categoría DGT.
//  - categoriaExplicita: si viene informada, se devuelve tal cual.
//  - si no, analiza el enunciado (peso 3) y, si se pasan, las opciones (peso 1).
// Devuelve siempre un texto: la categoría con más coincidencias o CATEGORIA_POR_DEFECTO si no hay ninguna.
/**
 * Asigna una categoría a una pregunta según su categoría explícita o sus textos.
 * El enunciado tiene más peso que las opciones; los empates respetan el orden
 * del catálogo.
 * @param {*} enunciado Texto del enunciado de la pregunta.
 * @param {string|null} [categoriaExplicita=null] Categoría ya asignada, si existe.
 * @param {Array<*>|null} [opciones=null] Opciones de respuesta de la pregunta.
 * @returns {string} Categoría seleccionada o la categoría predeterminada.
 */
function clasificarCategoriaDGT(enunciado, categoriaExplicita = null, opciones = null) {
  // Si la pregunta ya trae su categoría (campo "categoria" del JSON) se respeta tal cual
  if (typeof categoriaExplicita === "string" && categoriaExplicita.trim()) return categoriaExplicita.trim();

  const textoEnunciado = normalizarTextoDGT(enunciado);
  const textoOpciones = Array.isArray(opciones) ? normalizarTextoDGT(opciones.join(" . ")) : "";

  let mejor = CATEGORIA_POR_DEFECTO;
  let mejorPuntos = 0;
  CATEGORIAS_DGT.forEach((cat) => {
    let puntos = 0;
    cat.patrones.forEach((re) => {
      if (re.test(textoEnunciado)) puntos += 3;
      if (textoOpciones && re.test(textoOpciones)) puntos += 1;
    });
    if (puntos > mejorPuntos) { // estrictamente mayor: en empate gana la categoría que va antes
      mejorPuntos = puntos;
      mejor = cat.nombre;
    }
  });
  return mejor;
}

// Catálogo de categorías disponibles (en orden de prioridad) + la de por defecto
/**
 * Devuelve los nombres de las categorías disponibles en orden de prioridad.
 * @returns {string[]} Nombres del catálogo seguidos de la categoría predeterminada.
 */
function obtenerCategoriasDGT() {
  return [...CATEGORIAS_DGT.map((c) => c.nombre), CATEGORIA_POR_DEFECTO];
}

export {
  CATEGORIA_POR_DEFECTO,
  CATEGORIAS_DGT,
  TEMAS_DGT,
  normalizarTextoDGT,
  normalizarCategoriaDGT,
  clasificarCategoriaDGT,
  obtenerTemaDGT,
  obtenerCategoriasDGT
};
