/* =====================================================================
 *  dgt-eando · categorías DGT
 *  Clasificación automática de preguntas por palabras clave.
 *  Script clásico (sin módulos): expone sus funciones y constantes en el ámbito global.
 *  Cargar ANTES que js/storage.js.
 * ===================================================================== */

const CATEGORIA_POR_DEFECTO = "Otras normas";

// El orden importa: en caso de empate gana la categoría que aparece antes.
// Los patrones se aplican sobre texto en minúsculas y SIN tildes ni ñ (ver normalizarTextoDGT).
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

function normalizarTextoDGT(texto) {
  return String(texto === null || texto === undefined ? "" : texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")            // quita tildes (la ñ pasa a n)
    .replace(/\bluces? de cruce\b/g, "luz corta") // evita confundir "luz de cruce" con "cruce" de calles
    .replace(/\s+/g, " ");
}

// Asigna una categoría DGT.
//  - categoriaExplicita: si viene informada, se devuelve tal cual.
//  - si no, analiza el enunciado (peso 3) y, si se pasan, las opciones (peso 1).
// Devuelve siempre un texto: la categoría con más coincidencias o CATEGORIA_POR_DEFECTO si no hay ninguna.
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
function obtenerCategoriasDGT() {
  return [...CATEGORIAS_DGT.map((c) => c.nombre), CATEGORIA_POR_DEFECTO];
}
