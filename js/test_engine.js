/**
 * @module
 * @remarks
 * Controla la carga, representación y corrección de los tests y del repaso Anki.
 * Importa explícitamente de storage.js la persistencia, la cola de correcciones y las operaciones del mazo.
 * La interfaz que controla está definida en test.html.
 */

import {
  calificarTarjetaAnki,
  asegurarCategoriasDGT,
  categoriaDePregunta,
  claveTarjeta,
  cargarDatosTest,
  guardarFlagPregunta,
  guardarResultadoTest,
  hoyISO,
  inicializarMazoAnkiDesdeTests,
  necesitaInicializarMazo,
  obtenerCategoriasDebiles,
  obtenerColaRepasoHoy,
  obtenerColaPorTema,
  obtenerConfigAnki,
  obtenerParchePregunta,
  obtenerParchesPreguntas,
  obtenerProgreso,
  obtenerTarjetas,
  preguntasDeDatosTest,
  previsualizarIntervalosTarjeta,
  sincronizarDesdeNube,
  sincronizarFlagsSesion,
  sincronizarTestsSiToca,
  sumarDiasISO,
  esperarGuardadoProgreso,
  ultimaSincronizacionOk
} from './storage.js?v=12';
import { obtenerTemaDGT } from './categorias.js?v=1';

/**
 * Pregunta normalizada que consume el motor, tanto desde los JSON como desde los parches locales.
 * @typedef {Object} PreguntaTest
 * @property {string} texto Enunciado que se muestra.
 * @property {string[]} opciones Respuestas posibles, en su orden original.
 * @property {number} [correcta] Índice de la respuesta correcta; puede faltar en datos incompletos.
 * @property {string} [explicacion] Explicación de la respuesta.
 * @property {string} [imagen] Ruta de la imagen asociada.
 * @property {string} [id] Identificador persistente, presente en preguntas añadidas.
 * @property {string} [categoria] Categoría explícita de la pregunta.
 */

/**
 * Parche validado que actualiza una pregunta existente o añade una al final del test.
 * @typedef {Object} ParchePreguntaTest
 * @property {number} testId Número del test.
 * @property {number} preguntaIdx Índice de la pregunta, empezando en cero.
 * @property {string} enunciado Enunciado corregido.
 * @property {string[]} opciones Opciones corregidas.
 * @property {number} correcta Índice de la opción correcta.
 * @property {boolean} esNueva Indica si el parche añade una pregunta.
 * @property {string} [explicacion] Explicación corregida.
 * @property {string} [nota] Motivo opcional del reporte.
 * @property {string} [imagen] URL o ruta de la imagen.
 * @property {string} [imagenStoragePath] Ruta de la imagen en Supabase Storage.
 * @property {boolean} [sincronizado] Indica si se envió a Supabase.
 */

/**
 * Contexto de apertura y callbacks del modal de corrección.
 * @typedef {Object} ContextoCorreccion
 * @property {number} testId Número del test.
 * @property {number} preguntaIdx Índice de la pregunta, empezando en cero.
 * @property {PreguntaTest} [pregunta] Pregunta existente; si falta y esNueva es true, se crea una.
 * @property {boolean} [esNueva] Indica que la operación añade o edita una pregunta añadida.
 * @property {() => void} [alAbrir] Callback al abrir el modal.
 * @property {(parche: ParchePreguntaTest, resultado: Object) => void} [alGuardar] Callback tras guardar.
 * @property {() => void} [alCerrar] Callback al cerrar el modal.
 */

(function () {
  const params = new URLSearchParams(window.location.search);
  const modoParam = params.get('modo');
  const MODO = ['estudio', 'repaso', 'falladas', 'tema'].includes(modoParam) ? modoParam : 'examen';
  const TEMA_ID = params.get('tema');
  const letras = ['a', 'b', 'c', 'd'];
  const BANDERA_VISIBLE = ['repaso', 'falladas', 'tema'].includes(modoParam);

  /** @type {PreguntaTest[]} Preguntas cargadas para el test tradicional actual. */
  let PREGUNTAS = [];
  let BANDERA_TEST_VISIBLE = false;
  /** @type {?number} Identificador del test abierto, también expuesto para la interfaz. */
  window.TEST_ID = null;

  /**
   * Escapa caracteres HTML para interpolar texto de preguntas de forma segura.
   * @param {*} valor Valor que se convertirá en texto.
   * @returns {string} Texto con caracteres HTML escapados.
   */
  function escaparHTML(valor) {
    return String(valor).replace(/[&<>"]/g, (caracter) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    }[caracter]));
  }

  const lblModo = document.getElementById('lblModo');
  if (lblModo) {
    const tema = MODO === 'tema' ? obtenerTemaDGT(TEMA_ID) : null;
    lblModo.textContent = tema ? `Tema: ${tema.titulo}` : MODO === 'estudio' ? 'Modo estudio' : MODO === 'falladas' ? 'Preguntas falladas' : MODO === 'repaso' ? 'Repaso' : MODO === 'tema' ? 'Modo por tema' : 'Modo examen';
  }

  const form = document.getElementById('formTest');
  const contenedor = document.getElementById('preguntasContainer');
  const aviso = document.getElementById('avisoTest');
  const tituloNum = document.getElementById('testNum');
  const btnCorregir = document.getElementById('btnCorregir');
  const btnAnadirPregunta = document.getElementById('btnAnadirPregunta');
  const btnVolver = document.getElementById('btnVolver');
  const estadoGuardado = document.getElementById('estadoGuardado');

  form.addEventListener('submit', (event) => event.preventDefault());
  if (btnCorregir) btnCorregir.addEventListener('click', corregirTest);

  // Sincroniza con la nube en segundo plano nada más abrir: así el guardado parte del progreso
  // más reciente (evita pisar el historial de otro dispositivo si se abre el test directamente).
  /** @type {Promise<*>} Sincronización inicial del progreso; null si la sincronización no está disponible. */
  const sincronizacionInicial = (typeof sincronizarDesdeNube === 'function')
    ? sincronizarDesdeNube().catch((e) => { console.error(e); return null; })
    : Promise.resolve(null);

  window.addEventListener('beforeunload', () => {
    sincronizarFlagsSesion({ keepalive: true }).catch((err) => {
      console.error('Error enviando correcciones al cerrar la página:', err);
    });
  });

  if (btnVolver) {
    btnVolver.addEventListener('click', async (event) => {
      if (btnVolver.dataset.sincronizando === 'true') {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      btnVolver.dataset.sincronizando = 'true';
      btnVolver.setAttribute('aria-disabled', 'true');
      try {
        const [flags, progresoOk] = await Promise.all([
          sincronizarFlagsSesion(),
          esperarGuardadoProgreso()
        ]);
        if (!flags.ok) throw new Error('Supabase no confirmó el envío de las correcciones.');
        if (!progresoOk) throw new Error('El progreso pendiente no se pudo guardar en la nube.');
        window.location.assign(btnVolver.href);
      } catch (err) {
        console.error('No se pudieron sincronizar las correcciones antes de salir:', err);
        btnVolver.dataset.sincronizando = 'false';
        btnVolver.removeAttribute('aria-disabled');
        mostrarEstadoGuardado('aviso',
          'No se pudieron enviar las preguntas a la nube. Siguen guardadas en este dispositivo; vuelve a pulsar «Volver a la lista» para reintentar.' +
          mensajeErrorSincronizacion(err));
      }
    });
  }

  /* ================= AVISOS ================= */
  /**
   * Oculta el formulario y muestra un aviso bloqueante de carga o configuración.
   * @param {string} html Contenido HTML del aviso.
   * @returns {void}
   */
  function mostrarAviso(html) {
    form.style.display = 'none';
    aviso.style.cssText = 'display:block;padding:18px 20px;margin:24px 0;border-radius:var(--radius-2xl);' +
      'background:var(--aviso-fondo);border:1px solid var(--aviso-fondo);color:var(--aviso);line-height:1.5;';
    aviso.innerHTML = html + '<p style="margin:12px 0 0;"><a href="index.html">← Volver a la lista de tests</a></p>';
  }

  /**
   * Actualiza el estado accesible de guardado del test.
   * @param {'guardando'|'ok'|'aviso'} tipo Estado visual.
   * @param {string} texto Mensaje que se mostrará.
   * @returns {void}
   */
  function mostrarEstadoGuardado(tipo, texto) {
    const colores = {
      guardando: 'var(--texto-secundario)',
      ok: 'var(--primario)',
      aviso: 'var(--aviso)'
    };
    estadoGuardado.style.cssText = `margin-top:12px;font-size:var(--text-base);font-weight:var(--weight-semibold);color:${colores[tipo] || 'var(--texto-secundario)'};`;
    estadoGuardado.textContent = texto;
  }

  /**
   * Convierte un error de sincronización en un detalle corto para la interfaz.
   * @param {*} err Error original.
   * @returns {string} Sufijo legible, vacío si no hay mensaje.
   */
  function mensajeErrorSincronizacion(err) {
    const detalle = err && typeof err.message === 'string' ? err.message.trim() : '';
    return detalle ? ` (${detalle.slice(0, 240)})` : '';
  }

  /* ================= PARCHES DE PREGUNTAS ================= */
  /**
   * Aplica en memoria los datos normalizados de una corrección.
   * @param {PreguntaTest} pregunta Pregunta a mutar.
   * @param {ParchePreguntaTest} parche Corrección persistida.
   * @returns {PreguntaTest} La misma pregunta ya actualizada.
   */
  function aplicarParcheAPregunta(pregunta, parche) {
    if (!pregunta || !parche) return pregunta;
    pregunta.texto = parche.enunciado;
    pregunta.opciones = parche.opciones.slice();
    pregunta.correcta = parche.correcta;
    if (parche.explicacion) pregunta.explicacion = parche.explicacion;
    else delete pregunta.explicacion;
    if (parche.imagen) pregunta.imagen = parche.imagen;
    if (parche.imagenStoragePath) pregunta._imagenStoragePath = parche.imagenStoragePath;
    pregunta.corregida = true;
    delete pregunta.correcta_detectada;
    return pregunta;
  }

  /**
   * Superpone parches locales aún pendientes y agrega preguntas locales al JSON cargado.
   * El JSON remoto prevalece frente a parches ya sincronizados que difieran de su contenido.
   * @param {number} testId Identificador del test cargado.
   * @param {Object|PreguntaTest[]} data Datos originales del test.
   * @returns {Object|PreguntaTest[]} Los mismos datos, con parches aplicables incorporados.
   */
  function aplicarParchesATest(testId, data) {
    if (typeof obtenerParchePregunta !== 'function') return data;
    const preguntas = preguntasDeDatosTest(data);
    if (!preguntas) return data;
    const parches = typeof obtenerParchesPreguntas === 'function'
      ? Object.values(obtenerParchesPreguntas())
      : [];
    parches
      .filter((parche) => parche.testId === testId)
      .sort((a, b) => a.preguntaIdx - b.preguntaIdx)
      .forEach((parche) => {
        const pregunta = preguntas[parche.preguntaIdx];
        if (parche.esNueva && !pregunta && parche.preguntaIdx === preguntas.length) {
          const nueva = {
            id: claveTarjeta(testId, parche.preguntaIdx),
            texto: parche.enunciado,
            opciones: parche.opciones.slice(),
            correcta: parche.correcta,
            corregida: true,
            _localNueva: true
          };
          if (parche.explicacion) nueva.explicacion = parche.explicacion;
          if (parche.imagen) nueva.imagen = parche.imagen;
          if (parche.imagenStoragePath) nueva._imagenStoragePath = parche.imagenStoragePath;
          preguntas.push(nueva);
        } else if (pregunta && !parche.esNueva) {
          const coincideConJSON = pregunta.texto === parche.enunciado
            && pregunta.correcta === parche.correcta
            && Array.isArray(pregunta.opciones)
            && pregunta.opciones.length === parche.opciones.length
            && pregunta.opciones.every((opcion, indice) => opcion === parche.opciones[indice]);
          if (!parche.sincronizado || coincideConJSON) {
            aplicarParcheAPregunta(pregunta, parche);
          }
        }
    });
    return data;
  }

  /* ================= MODAL DE CORRECCIÓN ================= */
  let modalCorreccionAbierto = false;
  let ctxCorreccion = null;
  let guardandoCorreccion = false;

  const mc = {
    overlay: document.getElementById('modalCorreccion'),
    form: document.getElementById('formCorreccion'),
    titulo: document.getElementById('corrTitulo'),
    enunciado: document.getElementById('corrEnunciado'),
    opciones: [0, 1, 2].map((i) => document.getElementById(`corrOpcion${i}`)),
    radios: [0, 1, 2].map((i) => document.getElementById(`corrRadio${i}`)),
    explicacion: document.getElementById('corrExplicacion'),
    nota: document.getElementById('corrNota'),
    nuevaAviso: document.getElementById('corrPreguntaNuevaAviso'),
    imagenCampo: document.getElementById('corrImagenCampo'),
    imagenDrop: document.getElementById('corrImagenDrop'),
    imagenInput: document.getElementById('corrImagenArchivo'),
    imagenPreview: document.getElementById('corrImagenPreview'),
    imagenPreviewImg: document.getElementById('corrImagenPreviewImg'),
    imagenNombre: document.getElementById('corrImagenNombre'),
    error: document.getElementById('corrError'),
    cerrar: document.getElementById('corrCerrar'),
    cancelar: document.getElementById('corrCancelar'),
    guardar: document.getElementById('corrGuardar')
  };

  /**
   * Presenta un error de validación en el modal y enfoca el control inválido si se indica.
   * @param {string} texto Mensaje de validación; vacío para limpiar el error.
   * @param {HTMLElement} [campo] Campo al que se añadirá el estado inválido.
   * @returns {void}
   */
  function mostrarErrorCorreccion(texto, campo) {
    mc.error.textContent = texto;
    mc.error.hidden = !texto;
    [mc.enunciado, ...mc.opciones].forEach((control) => control.classList.remove('invalido'));
    if (campo) {
      campo.classList.add('invalido');
      campo.focus();
    }
  }

  let archivoImagenCorreccion = null;
  let urlVistaPreviaImagen = null;

  /**
   * Libera la URL temporal de la imagen y restablece la vista previa.
   * @returns {void}
   */
  function limpiarVistaPreviaImagen() {
    if (urlVistaPreviaImagen) URL.revokeObjectURL(urlVistaPreviaImagen);
    urlVistaPreviaImagen = null;
    mc.imagenPreview.hidden = true;
    mc.imagenPreviewImg.removeAttribute('src');
    mc.imagenNombre.textContent = '';
  }

  /**
   * Muestra una imagen seleccionada en el modal.
   * @param {string} src URL o ruta de la imagen.
   * @param {string} nombre Nombre que se muestra junto a la vista previa.
   * @param {boolean} [temporal=false] Si es temporal, se revoca al limpiar la vista previa.
   * @returns {void}
   */
  function mostrarVistaPreviaImagen(src, nombre, temporal = false) {
    limpiarVistaPreviaImagen();
    if (!src) return;
    urlVistaPreviaImagen = temporal ? src : null;
    mc.imagenPreviewImg.src = src;
    mc.imagenNombre.textContent = nombre || 'Imagen seleccionada';
    mc.imagenPreview.hidden = false;
  }

  /**
   * Valida el formato y tamaño de la imagen seleccionada y prepara su vista previa.
   * @param {File} archivo Archivo de imagen seleccionado por el usuario.
   * @returns {void}
   */
  function seleccionarImagenCorreccion(archivo) {
    if (!archivo) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(archivo.type)) {
      archivoImagenCorreccion = null;
      mc.imagenInput.value = '';
      limpiarVistaPreviaImagen();
      mostrarErrorCorreccion('La imagen debe ser JPG, PNG o WebP.');
      return;
    }
    if (archivo.size <= 0 || archivo.size > 5 * 1024 * 1024) {
      archivoImagenCorreccion = null;
      mc.imagenInput.value = '';
      limpiarVistaPreviaImagen();
      mostrarErrorCorreccion('La imagen debe ocupar entre 1 byte y 5 MB.');
      return;
    }
    archivoImagenCorreccion = archivo;
    mostrarErrorCorreccion('');
    mostrarVistaPreviaImagen(URL.createObjectURL(archivo), archivo.name, true);
  }

  /**
   * Deshabilita la selección de la opción c) cuando su texto está vacío.
   * @returns {void}
   */
  function sincronizarRadioC() {
    const vacia = !mc.opciones[2].value.trim();
    mc.radios[2].disabled = vacia;
    if (vacia && mc.radios[2].checked) mc.radios[2].checked = false;
  }

  /**
   * Rellena y abre el modal de corrección para una pregunta existente o nueva.
   * @param {ContextoCorreccion} ctx Identidad de la pregunta y callbacks del flujo.
   * @returns {void}
   */
  function abrirModalCorreccion(ctx) {
    if (!mc.overlay || modalCorreccionAbierto || !ctx || (!ctx.pregunta && !ctx.esNueva)) return;
    ctxCorreccion = ctx;
    const pregunta = ctx.pregunta || { texto: '', opciones: [], correcta: -1 };
    const parche = typeof obtenerParchePregunta === 'function'
      ? obtenerParchePregunta(ctx.testId, ctx.preguntaIdx)
      : null;

    const creandoNueva = ctx.esNueva && !ctx.pregunta;
    const accion = ctx.esNueva
      ? creandoNueva ? 'Añadir pregunta' : 'Editar pregunta añadida'
      : 'Corregir pregunta';
    mc.titulo.textContent = `${accion} · Test ${String(ctx.testId).padStart(3, '0')} · Pregunta ${String(ctx.preguntaIdx + 1).padStart(2, '0')}`;
    mc.nuevaAviso.hidden = !ctx.esNueva;
    mc.imagenCampo.hidden = !ctx.esNueva;
    mc.enunciado.value = pregunta.texto || '';
    mc.opciones.forEach((input, i) => { input.value = pregunta.opciones[i] || ''; });
    mc.radios.forEach((radio, i) => { radio.checked = typeof pregunta.correcta === 'number' && pregunta.correcta === i; });
    mc.explicacion.value = pregunta.explicacion || '';
    mc.nota.value = parche ? parche.nota : '';
    archivoImagenCorreccion = null;
    mc.imagenInput.value = '';
    limpiarVistaPreviaImagen();
    if (ctx.esNueva && pregunta.imagen) {
      mostrarVistaPreviaImagen(normalizarImagen(pregunta.imagen), 'Imagen actual');
    }
    sincronizarRadioC();
    mostrarErrorCorreccion('');
    mc.guardar.disabled = false;
    mc.guardar.textContent = creandoNueva ? 'Añadir pregunta' : 'Guardar corrección';

    modalCorreccionAbierto = true;
    if (typeof ctx.alAbrir === 'function') ctx.alAbrir();
    mc.overlay.classList.add('activo');
    mc.overlay.setAttribute('aria-hidden', 'false');
    mc.enunciado.focus();
  }

  /**
   * Cierra el modal si no hay una corrección en curso y notifica al contexto.
   * @returns {void}
   */
  function cerrarModalCorreccion() {
    if (!modalCorreccionAbierto || guardandoCorreccion) return;
    const ctx = ctxCorreccion;
    modalCorreccionAbierto = false;
    ctxCorreccion = null;
    mc.overlay.classList.remove('activo');
    mc.overlay.setAttribute('aria-hidden', 'true');
    archivoImagenCorreccion = null;
    limpiarVistaPreviaImagen();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (ctx && typeof ctx.alCerrar === 'function') ctx.alCerrar();
  }

  /**
   * Valida el formulario, persiste el flag y entrega el parche a la pantalla de origen.
   * @returns {Promise<void>}
   */
  async function guardarCorreccion() {
    if (!modalCorreccionAbierto || guardandoCorreccion || !ctxCorreccion) return;
    const ctx = ctxCorreccion;
    const opciones = mc.opciones.map((input) => input.value.trim());
    const enunciado = mc.enunciado.value.trim();
    const marcada = mc.radios.findIndex((radio) => radio.checked);

    if (!enunciado) return mostrarErrorCorreccion('El enunciado no puede estar vacío.', mc.enunciado);
    if (!opciones[0]) return mostrarErrorCorreccion('La opción a) es obligatoria.', mc.opciones[0]);
    if (!opciones[1]) return mostrarErrorCorreccion('La opción b) es obligatoria.', mc.opciones[1]);
    const textos = opciones[2] ? opciones : opciones.slice(0, 2);
    if (marcada < 0 || marcada >= textos.length) return mostrarErrorCorreccion('Marca cuál es la opción correcta.');

    guardandoCorreccion = true;
    mc.guardar.disabled = true;
    mc.guardar.textContent = 'Guardando...';
    let resultado;
    try {
      resultado = await guardarFlagPregunta({
        testId: ctx.testId,
        preguntaIdx: ctx.preguntaIdx,
        esNueva: ctx.esNueva === true,
        enunciado,
        opciones: textos,
        correcta: marcada,
        explicacion: mc.explicacion.value.trim(),
        nota: mc.nota.value.trim(),
        imagen: ctx.pregunta && ctx.pregunta.imagen ? ctx.pregunta.imagen : '',
        imagenStoragePath: ctx.pregunta && ctx.pregunta._imagenStoragePath
          ? ctx.pregunta._imagenStoragePath
          : '',
        imagenArchivo: archivoImagenCorreccion
      });
    } catch (err) {
      guardandoCorreccion = false;
      mc.guardar.disabled = false;
      mc.guardar.textContent = ctx.esNueva && !ctx.pregunta ? 'Añadir pregunta' : 'Guardar corrección';
      return mostrarErrorCorreccion(err && err.message ? err.message : 'No se pudo guardar la corrección.');
    }
    guardandoCorreccion = false;

    if (typeof ctx.alGuardar === 'function') ctx.alGuardar(resultado.parche, resultado);
    cerrarModalCorreccion();
  }

  if (mc.overlay) {
    mc.form.addEventListener('submit', (event) => {
      event.preventDefault();
      guardarCorreccion();
    });
    mc.cerrar.addEventListener('click', cerrarModalCorreccion);
    mc.cancelar.addEventListener('click', cerrarModalCorreccion);
    mc.opciones[2].addEventListener('input', sincronizarRadioC);
    mc.imagenInput.addEventListener('change', () => seleccionarImagenCorreccion(mc.imagenInput.files[0]));
    mc.imagenDrop.addEventListener('dragover', (event) => {
      event.preventDefault();
      mc.imagenDrop.classList.add('arrastrando');
    });
    mc.imagenDrop.addEventListener('dragleave', () => mc.imagenDrop.classList.remove('arrastrando'));
    mc.imagenDrop.addEventListener('drop', (event) => {
      event.preventDefault();
      mc.imagenDrop.classList.remove('arrastrando');
      seleccionarImagenCorreccion(event.dataTransfer.files[0]);
    });
    document.addEventListener('keydown', (event) => {
      if (!modalCorreccionAbierto) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cerrarModalCorreccion();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        guardarCorreccion();
      } else {
        event.stopPropagation();
      }
    }, true);
  }

  /* ================= PARÁMETROS DE URL ================= */
  /**
   * Lee y valida el parámetro id de la URL.
   * @returns {?number} ID positivo del test o null si falta o no es válido.
   */
  function obtenerIdTest() {
    const raw = (params.get('id') || '').trim();
    if (!/^\d{1,3}$/.test(raw)) return null;
    const n = parseInt(raw, 10);
    return n >= 1 ? n : null;
  }

  // Usa cargarDatosTest (storage.js): prueba data/test_070.json y luego data/test_70.json
  /**
   * Carga el JSON de un test mediante el cargador compartido de storage.js.
   * @param {number} n ID numérico del test.
   * @returns {Promise<Object|PreguntaTest[]>} Datos del test.
   * @throws {Error} Si el archivo no existe o no puede cargarse.
   */
  async function cargarJSONTest(n) {
    const data = await cargarDatosTest(n);
    if (!data) throw new Error(`No se pudo cargar data/test_${String(n).padStart(3, '0')}.json`);
    return data;
  }

  /**
   * Normaliza las rutas heredadas de imágenes para usarlas desde test.html.
   * @param {string} ruta Ruta recibida desde el JSON.
   * @returns {string} Ruta normalizada o cadena vacía.
   */
  function normalizarImagen(ruta) {
    return ruta ? String(ruta).replace(/^\.\.\//, '') : '';
  }

  /* ================= RENDER (modos examen / estudio) ================= */
  /**
   * Construye y monta todas las tarjetas del test tradicional.
   * @returns {void}
   */
  function renderPreguntas() {
    contenedor.innerHTML = '';

    PREGUNTAS.forEach((preg, idx) => {
      contenedor.appendChild(crearTarjetaPregunta(preg, idx));
    });
  }

  /**
   * Crea el DOM de una tarjeta, sus opciones, imagen y controles de corrección.
   * @param {PreguntaTest} preg Datos de la pregunta.
   * @param {number} idx Índice de la pregunta, empezando en cero.
   * @returns {HTMLElement} Artículo listo para insertar en el documento.
   */
  function crearTarjetaPregunta(preg, idx) {
    const imagenSrc = normalizarImagen(preg.imagen);
    const tieneImg = Boolean(imagenSrc);
    const article = document.createElement('article');
    article.className = `pregunta-item ${tieneImg ? '' : 'sin-imagen'}`;
    article.id = `pregunta-${idx}`;

    const opcionesHTML = preg.opciones.map((textoOp, opIdx) => `
      <label class="opcion opcion--test" id="lbl-${idx}-${opIdx}">
        <input type="radio" name="p_${idx}" value="${opIdx}">
        <span><span class="opcion-letra">${letras[opIdx]})</span> ${escaparHTML(textoOp)}</span>
      </label>
    `).join('');

    const imagenHTML = tieneImg
      ? `<div class="pregunta-media"><img src="${imagenSrc}" alt="Imagen pregunta ${idx + 1}"></div>`
      : '';
    const parche = BANDERA_TEST_VISIBLE && typeof obtenerParchePregunta === 'function'
      ? obtenerParchePregunta(window.TEST_ID, idx)
      : null;
    const banderaHTML = BANDERA_TEST_VISIBLE
      ? `<button type="button" class="btn-bandera btn-bandera-test${parche ? ' corregida' : ''}" data-pregunta-idx="${idx}" title="${parche ? 'Editar corrección guardada' : 'Reportar o corregir esta pregunta'}" aria-label="Reportar o corregir pregunta ${idx + 1}">${ICONO_BANDERA}</button>`
      : '';

    article.innerHTML = `
      ${banderaHTML}
      <div class="pregunta-cuerpo">
        <div class="pregunta-enunciado">
          <span class="p-num">${idx + 1}.</span> ${escaparHTML(preg.texto)}
        </div>
        <div class="opciones-lista">
          ${opcionesHTML}
        </div>
      </div>
      ${imagenHTML}
    `;

    if (MODO === 'estudio') {
      article.querySelectorAll('input[type="radio"]').forEach((radio) => {
        radio.addEventListener('change', (event) => {
          marcarCorreccionPregunta(idx, Number(event.target.value));
        });
      });
    }

    return article;
  }

  /**
   * Abre la edición de una pregunta del test tradicional y repinta la tarjeta al guardar.
   * @param {number} preguntaIdx Índice de la pregunta, empezando en cero.
   * @returns {void}
   */
  function abrirCorreccionTest(preguntaIdx) {
    const pregunta = PREGUNTAS[preguntaIdx];
    if (!BANDERA_TEST_VISIBLE || !pregunta) return;

    const tarjeta = document.getElementById(`pregunta-${preguntaIdx}`);
    abrirModalCorreccion({
      testId: Number(window.TEST_ID),
      preguntaIdx,
      pregunta,
      alGuardar: (parche) => {
        const seleccionada = tarjeta.querySelector(`input[name="p_${preguntaIdx}"]:checked`);
        const respuesta = seleccionada ? Number(seleccionada.value) : null;
        const estabanBloqueadas = tarjeta.querySelector('input[type="radio"]')?.disabled === true;
        aplicarParcheAPregunta(pregunta, parche);
        const actualizada = crearTarjetaPregunta(pregunta, preguntaIdx);

        actualizada.querySelectorAll('input[type="radio"]').forEach((radio) => {
          radio.disabled = estabanBloqueadas;
          if (respuesta !== null && Number(radio.value) === respuesta) radio.checked = true;
        });
        tarjeta.replaceWith(actualizada);
        if (respuesta !== null && MODO === 'estudio') {
          marcarCorreccionPregunta(preguntaIdx, respuesta);
        }
      },
      alCerrar: () => {
        const boton = document.querySelector(`#pregunta-${preguntaIdx} .btn-bandera-test`);
        if (boton) boton.focus();
      }
    });
  }

  /**
   * Abre el modal para añadir una pregunta al final o editar la última pregunta local nueva.
   * @returns {void}
   */
  function abrirAltaPregunta() {
    if (!btnAnadirPregunta || !window.TEST_ID) return;
    const ultima = PREGUNTAS[PREGUNTAS.length - 1];
    if (ultima && ultima._localNueva) {
      abrirModalCorreccion({
        testId: Number(window.TEST_ID),
        preguntaIdx: PREGUNTAS.length - 1,
        pregunta: ultima,
        esNueva: true,
        alGuardar: (parche) => {
          aplicarParcheAPregunta(ultima, parche);
          const tarjeta = document.getElementById(`pregunta-${PREGUNTAS.length - 1}`);
          const actualizada = crearTarjetaPregunta(ultima, PREGUNTAS.length - 1);
          if (tarjeta) tarjeta.replaceWith(actualizada);
        }
      });
      return;
    }

    abrirModalCorreccion({
      testId: Number(window.TEST_ID),
      preguntaIdx: PREGUNTAS.length,
      esNueva: true,
      alGuardar: (parche) => {
        const nueva = {
          id: claveTarjeta(window.TEST_ID, PREGUNTAS.length),
          texto: parche.enunciado,
          opciones: parche.opciones.slice(),
          correcta: parche.correcta,
          corregida: true,
          _localNueva: true
        };
        if (parche.explicacion) nueva.explicacion = parche.explicacion;
        if (parche.imagen) nueva.imagen = parche.imagen;
        if (parche.imagenStoragePath) nueva._imagenStoragePath = parche.imagenStoragePath;
        PREGUNTAS.push(nueva);
        contenedor.appendChild(crearTarjetaPregunta(nueva, PREGUNTAS.length - 1));
        if (corrigiendo) {
          corrigiendo = false;
          if (btnCorregir) btnCorregir.disabled = false;
          contenedor.querySelectorAll('input[type="radio"]').forEach((radio) => { radio.disabled = false; });
          const resultado = document.getElementById('resultadoPanel');
          if (resultado) {
            resultado.style.display = 'none';
            resultado.innerHTML = '';
          }
          estadoGuardado.textContent = '';
          const btnVolver = document.getElementById('btnVolver');
          if (btnVolver) btnVolver.style.display = 'none';
        }
      }
    });
  }

  if (btnAnadirPregunta) {
    btnAnadirPregunta.addEventListener('click', abrirAltaPregunta);
  }

  contenedor.addEventListener('click', (event) => {
    const boton = event.target.closest && event.target.closest('.btn-bandera-test');
    if (!boton) return;
    event.preventDefault();
    abrirCorreccionTest(Number(boton.dataset.preguntaIdx));
  });

  /**
   * Actualiza el feedback visual de la respuesta en modo estudio o tras corregir el test.
   * @param {number} idx Índice de la pregunta, empezando en cero.
   * @param {number} seleccion Índice de la opción seleccionada; -1 indica pregunta sin responder.
   * @returns {void}
   */
  function marcarCorreccionPregunta(idx, seleccion) {
    const correcta = PREGUNTAS[idx].correcta;
    if (typeof correcta !== 'number') return; // JSON sin respuesta correcta conocida
    PREGUNTAS[idx].opciones.forEach((_, opIdx) => {
      const lbl = document.getElementById(`lbl-${idx}-${opIdx}`);
      lbl.classList.remove('opcion--correcta', 'opcion--fallo');
      if (opIdx === correcta) {
        lbl.classList.add('opcion--correcta');
      } else if (seleccion === opIdx && seleccion !== correcta) {
        lbl.classList.add('opcion--fallo');
      }
    });
  }

  /* ================= CORRECCIÓN + GUARDADO ================= */
  let corrigiendo = false;

  /**
   * Corrige el intento tradicional, guarda su resultado y sincroniza los flags de sesión.
   * @returns {Promise<void>}
   * @mermaid
   * ```mermaid
   * flowchart TD
   *   A[Enviar respuestas] --> B[Calcular aciertos y fallos]
   *   B --> C[Guardar resultado local y remoto]
   *   C --> D[Sincronizar flags pendientes]
   *   D --> E[Mostrar estado final]
   * ```
   */
  async function corregirTest() {
    if (corrigiendo || !PREGUNTAS.length) return;
    corrigiendo = true;
    if (btnCorregir) btnCorregir.disabled = true;

    let aciertos = 0;
    const indicesFallados = []; // pasan al mazo Anki como "again"

    PREGUNTAS.forEach((preg, idx) => {
      const seleccionado = document.querySelector(`input[name="p_${idx}"]:checked`);
      const valor = seleccionado ? Number(seleccionado.value) : -1;
      if (valor === preg.correcta) {
        aciertos++;
      } else if (typeof preg.correcta === 'number') {
        indicesFallados.push(idx);
      }
      marcarCorreccionPregunta(idx, valor);
    });

    // Bloquear radios tras corregir
    contenedor.querySelectorAll('input[type="radio"]').forEach(r => r.disabled = true);

    const total = PREGUNTAS.length;
    const fallos = total - aciertos; // las preguntas sin responder cuentan como fallo
    const esApto = fallos <= 3;

    const panel = document.getElementById('resultadoPanel');
    panel.className = `resultado-panel ${esApto ? 'apto' : 'no-apto'}`;
    panel.style.display = 'block';
    panel.innerHTML = `
      <strong>${esApto ? '¡APTO!' : 'NO APTO'}</strong> —
      Aciertos: <strong>${aciertos}</strong> / ${total} |
      Fallos: <strong>${fallos}</strong>
      <span id="infoIntentos"></span>
    `;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Mientras se guarda, el botón de volver permanece oculto para no perder el intento
    const btnVolver = document.getElementById('btnVolver');
    if (btnVolver) btnVolver.style.display = 'none';

    const sinRespuestas = PREGUNTAS.every(p => typeof p.correcta !== 'number');
    if (sinRespuestas) {
      let falloFlags = false;
      let errorFlags = '';
      try {
        await sincronizarFlagsSesion();
      } catch (err) {
        console.error('Error sincronizando correcciones al terminar el test:', err);
        falloFlags = true;
        errorFlags = mensajeErrorSincronizacion(err);
      }
      mostrarEstadoGuardado('aviso',
        'Este test no tiene respuestas correctas en su JSON: no se ha guardado el resultado.' +
        (falloFlags ? ` Las correcciones siguen guardadas en este dispositivo, pero no se pudieron enviar.${errorFlags}` : ''));
      if (btnVolver) btnVolver.style.display = 'inline-flex';
      return;
    }

    mostrarEstadoGuardado('guardando', 'Guardando progreso...');

    let guardadoNube = true;
    let falloSincronizacionFlags = false;
    let correccionesEnviadas = 0;
    let errorSincronizacionFlags = '';
    try {
      await sincronizacionInicial;                       // parte del progreso más reciente de la nube
      const clave = `test_${String(window.TEST_ID).padStart(3, '0')}`;  // misma clave que usa index.js
      const resultado = await guardarResultadoTest(clave, aciertos, fallos, total, indicesFallados, PREGUNTAS);
      if (resultado === false) guardadoNube = false;     // storage.js devuelve false si Supabase falló

      const guardado = obtenerProgreso()[clave];
      const info = document.getElementById('infoIntentos');
      if (info && guardado) info.innerHTML = ` | Veces realizado: <strong>${guardado.intentos}</strong>`;
    } catch (err) {
      console.error('Error guardando el resultado:', err);
      guardadoNube = false;
    }

    try {
      const resultadoFlags = await sincronizarFlagsSesion();
      falloSincronizacionFlags = !resultadoFlags.ok;
      correccionesEnviadas = resultadoFlags.enviados || 0;
    } catch (err) {
      console.error('Error sincronizando correcciones al terminar el test:', err);
      falloSincronizacionFlags = true;
      errorSincronizacionFlags = mensajeErrorSincronizacion(err);
    }

    const nFallos = indicesFallados.length;
    const notaRepaso = nFallos
      ? ` · ${nFallos} ${nFallos === 1 ? 'fallo añadido' : 'fallos añadidos'} al repaso Anki`
      : '';

    const mensajesEstado = [
      guardadoNube
        ? '✓ Progreso guardado en la nube'
        : 'No se pudo confirmar el guardado del resultado en la nube; sigue guardado en este dispositivo.',
      correccionesEnviadas
        ? `${correccionesEnviadas} ${correccionesEnviadas === 1 ? 'corrección enviada' : 'correcciones enviadas'}`
        : '',
      falloSincronizacionFlags
        ? `No se pudieron enviar algunas correcciones; siguen guardadas en este dispositivo.${errorSincronizacionFlags}`
        : '',
      notaRepaso
    ].filter(Boolean);
    mostrarEstadoGuardado(
      guardadoNube && !falloSincronizacionFlags ? 'ok' : 'aviso',
      mensajesEstado.join(' · ')
    );

    if (btnVolver) btnVolver.style.display = 'inline-flex';
  }

  /* =====================================================================
   *  MODO REPASO (Anki): una tarjeta cada vez, controlado por teclado
   *  Estructura: barra superior persistente (cerrar · progreso · racha)
   *  + escenario (#repasoStage) donde se pinta cada tarjeta.
   * ===================================================================== */
  const TECLA_A_NIVEL = { '1': 'hard', '2': 'medium', '3': 'easy', '4': 'again' };
  const NIVELES = [
    { nivel: 'hard', tecla: '1', etiqueta: 'Hard' },
    { nivel: 'medium', tecla: '2', etiqueta: 'Medium' },
    { nivel: 'easy', tecla: '3', etiqueta: 'Easy' },
    { nivel: 'again', tecla: '4', etiqueta: 'Again' }
  ];
  const ETIQUETA_MADUREZ = { nueva: 'Nueva', aprendiendo: 'Aprendiendo', joven: 'Joven', madura: 'Madura' };
  const ETIQUETA_NIVEL = { hard: 'Hard', medium: 'Medium', easy: 'Easy', again: 'Again' };
  const PUESTOS_REENCOLAR = 4; // "again": la tarjeta vuelve a salir unos puestos más adelante
  const TAMANO_BLOQUE_REPASO = 10;
  const MS_SALIDA = 120;       // duración de la animación de salida de la tarjeta (debe coincidir con .repaso-stage.saliendo en test.css)

  const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const ICONO_CHECK = `<svg ${SVG_ATTRS}><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
  const ICONO_BANDERA = `<svg ${SVG_ATTRS}><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>`;
  const ICONO_ASPA = `<svg ${SVG_ATTRS}><path d="M6 6l12 12M18 6L6 18"/></svg>`;

  /**
   * Inicializa la experiencia de repaso Anki y coordina su sesión, tarjetas y vistas.
   * @returns {void}
   * @mermaid
   * ```mermaid
   * sequenceDiagram
   *   participant UI as Interfaz
   *   participant Store as storage.js
   *   participant Tests as data/test_XXX.json
   *   UI->>Store: sincronizar progreso y mazo
   *   Store->>Tests: cargar preguntas del bloque
   *   Tests-->>Store: preguntas válidas
   *   Store-->>UI: tarjetas listas
   *   UI->>UI: mostrar pregunta y capturar respuesta
   * ```
   */
  function iniciarRepaso() {
    const cont = document.getElementById('repasoContainer');
    if (!cont) return;

    document.documentElement.classList.add(`modo-${MODO}`);
    form.style.display = 'none';
    cont.style.display = 'flex';
    document.title = MODO === 'falladas' ? 'Repaso de falladas · dgt-eando' : 'Repaso · dgt-eando';

    const cacheTests = new Map();          // testId -> JSON del test
    let sesion = null;                     // tarjetas pendientes/futuras y resumen de la sesión
    let fase = 'carga';                    // carga | pregunta | confianza | guardando | resumen-bloque | finalizando | final
    let claveActual = null;
    let pregActual = null;
    let numOpciones = 0;
    let bloqueoHasta = 0;
    let correctaVisual = -1;               // posición (0-based) de la correcta tal y como se ve en pantalla

    // --- Medición de tiempo (silenciosa: no se muestra ningún contador) ---
    const TOPE_TIEMPO_SEG = 60;            // tope por pregunta (= límite oficial DGT: 1 min/pregunta)
    const REFERENCIA_INICIAL_SEG = 10;     // mediana "neutral" mientras haya < 3 respuestas
    const MIN_RESPUESTAS_MEDIANA = 3;
    const tiemposSesion = [];              // segundos (tope 60) de las preguntas respondidas en esta sesión
    let inicioTarjeta = null;              // performance.now() al mostrar la tarjeta
    let tiempoActual = 0;                  // tiempo congelado de la tarjeta actual (1 decimal)
    let nivelSugerido = '';                // 'hard' | 'medium' | 'easy' | 'again'
    let aciertoActual = false;             // si la respuesta de la tarjeta actual fue correcta
    let ordenVisual = [];
    let seleccionVisual = -1;
    let rachaPrevia = 0;
    let rachaMaxPrevia = 0;
    let tiemposPrevios = [];
    let primeraVezActual = false;
    let pausaCorreccion = null;

    /**
     * Busca un elemento por su ID dentro del documento.
     * @param {string} id ID del elemento.
     * @returns {?HTMLElement} Elemento encontrado o null.
     */
    const el = (id) => document.getElementById(id);
    /**
     * Escapa texto antes de interpolarlo en una plantilla HTML.
     * @param {*} s Valor que se convertirá en texto.
     * @returns {string} Texto con caracteres HTML escapados.
     */
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    /**
     * Comprueba la preferencia del usuario para reducir el movimiento.
     * @returns {boolean} true si el sistema solicita reducir animaciones.
     */
    const reducirMovimiento = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Fisher–Yates (modifica y devuelve el array)
    /**
     * Baraja un array in situ mediante Fisher–Yates.
     * @template T
     * @param {T[]} arr Elementos que se mezclarán.
     * @returns {T[]} El mismo array, ya barajado.
     */
    function barajarArray(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    /**
     * Calcula la mediana de una colección numérica sin modificarla.
     * @param {number[]} valores Valores de entrada.
     * @returns {number} Mediana o cero si no hay valores.
     */
    function calcularMediana(valores) {
      if (!valores.length) return 0;
      const orden = [...valores].sort((a, b) => a - b);
      const mitad = Math.floor(orden.length / 2);
      return orden.length % 2 ? orden[mitad] : (orden[mitad - 1] + orden[mitad]) / 2;
    }

    /**
     * Formatea segundos con una cifra decimal.
     * @param {number} s Tiempo en segundos.
     * @returns {string} Tiempo formateado con sufijo s.
     */
    const fmtSeg = (s) => `${(Math.round(s * 10) / 10).toFixed(1)}s`;

    /**
     * Formatea una fecha ISO (AAAA-MM-DD) como fecha breve en español.
     * @param {string} iso Fecha ISO.
     * @returns {string} Fecha localizada y abreviada.
     */
    function fechaCortaISO(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d)
        .toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
        .replace(/\./g, '');
    }

    // Cronómetro silencioso: solo guarda el instante de inicio; no pinta nada en pantalla
    /**
     * Registra el instante de inicio de la tarjeta actual.
     * @returns {void}
     */
    function iniciarCronometro() {
      inicioTarjeta = performance.now();
    }

    // Congela el tiempo exacto al responder (tope 60 s, 1 decimal) en tiempoActual
    /**
     * Detiene el cronómetro y guarda el tiempo de respuesta con el límite configurado.
     * @returns {void}
     */
    function detenerCronometro() {
      if (inicioTarjeta === null) return;
      const seg = Math.min(TOPE_TIEMPO_SEG, (performance.now() - inicioTarjeta) / 1000);
      inicioTarjeta = null;
      tiempoActual = Math.round(seg * 10) / 10;
    }

    // Tiempo esperado para ESTA tarjeta:
    //   con historial (tiempoMedioSeg > 0): 65 % su tiempo medio histórico + 35 % mediana de hoy
    //   sin historial: la mediana de hoy (10 s de referencia neutral mientras haya < 3 respuestas)
    /**
     * Combina el historial de la tarjeta con el ritmo reciente de la sesión.
     * @param {number[]} tiemposPrevios Tiempos de respuesta anteriores de esta sesión.
     * @param {number} tiempoMedioTarjeta Media histórica de la tarjeta, si existe.
     * @returns {{real: boolean, medianaHoy: number, hist: boolean, esperado: number}} Referencia calculada.
     */
    function calcularReferencia(tiemposPrevios, tiempoMedioTarjeta) {
      const real = tiemposPrevios.length >= MIN_RESPUESTAS_MEDIANA;
      const medianaHoy = real ? calcularMediana(tiemposPrevios) : REFERENCIA_INICIAL_SEG;
      const hist = Number(tiempoMedioTarjeta) > 0;
      const esperado = hist ? (0.65 * Number(tiempoMedioTarjeta)) + (0.35 * medianaHoy) : medianaHoy;
      return { real, medianaHoy, hist, esperado };
    }

    // La sugerencia solo destaca un botón: la calificación final la elige siempre el usuario.
    /**
     * Sugiere un nivel de confianza a partir de acierto y duración, sin calificar automáticamente.
     * @param {boolean} acierto Si la respuesta fue correcta.
     * @param {number} tiempo Tiempo empleado en segundos.
     * @param {number[]} tiemposPrevios Tiempos anteriores de la sesión.
     * @param {number} tiempoMedioTarjeta Media histórica de la tarjeta.
     * @returns {{nivel: 'hard'|'medium'|'easy'|'again', texto: string}} Nivel sugerido y explicación.
     */
    function sugerirConfianza(acierto, tiempo, tiemposPrevios, tiempoMedioTarjeta) {
      const r = calcularReferencia(tiemposPrevios, tiempoMedioTarjeta);
      const esp = fmtSeg(r.esperado);
      const t = fmtSeg(tiempo);

      if (!acierto) return { nivel: 'again', texto: `Incorrecta (${t})` };

      if (tiempo <= r.esperado * 0.85) {
        let texto;
        if (r.hist) {
          const pct = Math.round((tiempo / r.esperado - 1) * 100);
          texto = `¡Más rápida! ${t} vs esperado ${esp} (${pct > 0 ? '+' : ''}${pct}%)`;
        } else {
          texto = r.real ? `Rápida hoy (${t} vs ${esp})` : `Rápida (${t} vs referencia ${esp})`;
        }
        return { nivel: 'easy', texto };
      }
      if (tiempo <= r.esperado * 1.30) return { nivel: 'medium', texto: `Ritmo esperado (${t} vs ${esp})` };
      return { nivel: 'hard', texto: `Más lenta de lo esperado (${t} vs ${esp})` };
    }

    /**
     * Presenta el estado de carga del repaso.
     * @param {string} texto Mensaje de progreso.
     * @returns {void}
     */
    function pintarCarga(texto) {
      fase = 'carga';
      cont.innerHTML = `<div class="repaso-carga"><div class="repaso-spinner" aria-hidden="true"></div><p>${esc(texto)}</p></div>`;
    }

    /**
     * Sustituye el escenario por un aviso final con enlace de retorno.
     * @param {string} html Contenido HTML del aviso.
     * @returns {void}
     */
    function pintarAviso(html) {
      fase = 'final';
      cont.innerHTML = `<div class="repaso-final"><p class="repaso-final-sub">${html}</p><a class="btn btn--primario btn--lg" href="index.html">Volver al panel</a></div>`;
    }

    /**
     * Resuelve la pregunta válida asociada a una clave de tarjeta Anki.
     * @param {string} clave Clave persistente de la tarjeta.
     * @returns {?PreguntaTest} Pregunta con opciones y respuesta correcta, o null si no es válida.
     */
    function preguntaDeClave(clave) {
      const t = obtenerTarjetas()[clave];
      if (!t) return null;
      const preguntas = preguntasDeDatosTest(cacheTests.get(t.testId));
      const p = preguntas ? preguntas[t.preguntaIdx] : null;
      return p && Array.isArray(p.opciones) && typeof p.correcta === 'number' ? p : null;
    }

    /**
     * Carga hasta diez tarjetas siguientes, sus tests y las preguntas válidas para el bloque.
     * @returns {Promise<number>} Cantidad de tarjetas cargadas correctamente.
     */
    async function cargarSiguienteBloquePreguntas() {
      const claves = sesion.siguientes.splice(0, TAMANO_BLOQUE_REPASO);
      const tarjetas = obtenerTarjetas();
      const ids = [...new Set(claves.map((clave) => tarjetas[clave].testId))]
        .filter((id) => !cacheTests.has(id));
      await Promise.all(ids.map(async (id) => {
        const data = await cargarDatosTest(id);
        cacheTests.set(id, data ? aplicarParchesATest(id, data) : data);
      }));
      const validas = claves.filter((clave) => preguntaDeClave(clave));
      sesion.total -= claves.length - validas.length;
      sesion.pendientes.push(...validas);
      return validas.length;
    }

    /**
     * Convierte el intervalo de repetición en la etiqueta que se muestra en un botón.
     * @param {'hard'|'medium'|'easy'|'again'} nivel Nivel de confianza.
     * @param {number} dias Días hasta la siguiente repetición.
     * @returns {string} Etiqueta localizada del intervalo.
     */
    function etiquetaIntervalo(nivel, dias) {
      if (nivel === 'again' || !(dias > 0)) return 'Hoy';
      return dias === 1 ? '1 día' : `${dias} días`;
    }

    /* ---------- Barra superior (persistente entre tarjetas) ---------- */
    /**
     * Renderiza la cabecera persistente y el escenario de tarjetas del repaso.
     * @returns {void}
     */
    function montarShell() {
      cont.innerHTML = `
        <header class="repaso-topbar">
          <div class="repaso-topbar-inner">
            <a href="index.html" class="repaso-cerrar" id="repasoSalir" aria-label="Salir del repaso" title="Salir">✕</a>
            <div class="repaso-progreso-wrap">
              <div class="repaso-progreso" id="repasoProgreso" role="progressbar" aria-label="Progreso del repaso" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <div class="repaso-progreso-barra" id="repasoBarra"></div>
              </div>
              <div class="repaso-contador" id="repasoContador">0 / 0</div>
            </div>
            <div class="repaso-topbar-acciones">
              ${BANDERA_VISIBLE ? `<button type="button" class="btn-bandera" id="btnBandera" title="Corregir esta pregunta" aria-label="Corregir esta pregunta">${ICONO_BANDERA}</button>` : ''}
              <div class="repaso-combo" id="repasoCombo" title="Racha de aciertos seguidos" aria-live="polite">
                <span class="repaso-combo-fuego" aria-hidden="true">🔥</span>
                <span id="repasoComboNum">0</span>
              </div>
            </div>
          </div>
        </header>
        <main class="repaso-stage" id="repasoStage"></main>
      `;
    }

    /**
     * Actualiza la barra y el contador de avance de la sesión.
     * @returns {void}
     */
    function actualizarProgreso() {
      const pct = sesion.total ? Math.min(100, Math.round((sesion.hechas / sesion.total) * 100)) : 0;
      const barra = el('repasoBarra');
      if (barra) barra.style.width = `${pct}%`;
      const pb = el('repasoProgreso');
      if (pb) pb.setAttribute('aria-valuenow', String(pct));
      const c = el('repasoContador');
      if (c) c.textContent = `${Math.min(sesion.hechas + 1, sesion.total)} / ${sesion.total}`;
    }

    // anim: 'pop' (acierto seguido) | 'cae' (racha reiniciada) | null (solo pintar)
    /**
     * Pinta la racha actual y, si corresponde, dispara su animación.
     * @param {'pop'|'cae'|null} anim Animación de acierto o reinicio; null solo actualiza.
     * @returns {void}
     */
    function pintarCombo(anim) {
      const combo = el('repasoCombo');
      const num = el('repasoComboNum');
      if (!combo || !num) return;
      num.textContent = String(sesion.racha);
      combo.classList.toggle('activo', sesion.racha > 0);
      if (anim) {
        combo.classList.remove('pop', 'cae');
        void combo.offsetWidth; // reinicia la animación aunque se repita seguida
        combo.classList.add(anim);
      }
    }

    /* ---------- Pantalla de tarjeta ---------- */
    /**
     * Decide si muestra tarjeta, resumen de bloque, carga adicional o resumen final.
     * @returns {void}
     */
    function mostrarTarjeta() {
      if (!sesion.pendientes.length) {
        if (sesion.siguientes.length && sesion.respondidasBloque > 0) {
          mostrarResumenBloque();
        } else if (sesion.siguientes.length) {
          cargarSiguienteBloquePreguntas()
            .then((cargadas) => cargadas ? mostrarTarjeta() : mostrarFinal())
            .catch((err) => {
              console.error('Error cargando el siguiente bloque de preguntas:', err);
              pintarAviso('No se pudieron cargar las siguientes preguntas. Comprueba tu conexión e inténtalo de nuevo.');
            });
        } else {
          mostrarFinal();
        }
        return;
      }

      claveActual = sesion.pendientes[0];
      pregActual = preguntaDeClave(claveActual);
      if (!pregActual) {               // la pregunta ya no existe en el JSON: se salta
        sesion.pendientes.shift();
        sesion.total = Math.max(sesion.hechas, sesion.total - 1);
        mostrarTarjeta();
        return;
      }

      numOpciones = pregActual.opciones.length;
      fase = 'pregunta';

      if (!el('repasoStage')) montarShell();
      const stage = el('repasoStage');
      stage.classList.remove('saliendo');
      actualizarProgreso();
      pintarCombo(null);

      generarOrdenVisual();
      seleccionVisual = -1;
      pintarTarjeta();
      actualizarEstadoBandera();

      window.scrollTo(0, 0);
      iniciarCronometro();
    }

    /**
     * Establece el orden visible de las opciones y calcula el índice visual de la correcta.
     * @returns {void}
     */
    function generarOrdenVisual() {
      const barajar = typeof obtenerConfigAnki === 'function' && obtenerConfigAnki().barajarOpciones === true;
      ordenVisual = pregActual.opciones.map((_, i) => i);
      if (barajar) barajarArray(ordenVisual);
      correctaVisual = ordenVisual.indexOf(pregActual.correcta);
    }

    /**
     * Renderiza la tarjeta actual con enunciado, opciones, contexto y controles.
     * @returns {void}
     */
    function pintarTarjeta() {
      const stage = el('repasoStage');
      const tarjeta = obtenerTarjetas()[claveActual];
      const imagenSrc = normalizarImagen(pregActual.imagen);
      const repeticion = sesion.repetidas.has(claveActual) ? '<span class="badge badge--aviso badge--mayus badge--sm">Repetición</span>' : '';
      const refTest = String(tarjeta.testId).padStart(3, '0');
      const refPregunta = String((Number(tarjeta.preguntaIdx) || 0) + 1).padStart(2, '0');
      // Categoría DGT: la guardada en la tarjeta o, si aún no se ha migrado, la calculada al vuelo
      const categoria = tarjeta.categoria
        || (typeof categoriaDePregunta === 'function' ? categoriaDePregunta(pregActual) : '');

      const opcionesHTML = ordenVisual.map((idxOriginal, i) => `
        <button type="button" class="opcion opcion--tarjeta" data-op="${i}">
          <span class="repaso-tecla" aria-hidden="true">${i + 1}</span>
          <span class="repaso-opcion-texto"><span class="opcion-letra">${letras[i]})</span> ${esc(pregActual.opciones[idxOriginal])}</span>
          <span class="repaso-opcion-icono" aria-hidden="true"></span>
        </button>
      `).join('');

      stage.innerHTML = `
        <article class="repaso-tarjeta ${imagenSrc ? 'con-imagen' : ''}" id="repasoTarjeta">
          <div class="repaso-contexto">
            <span class="repaso-contexto-izq">
              <span>Test ${esc(refTest)} · Pregunta ${esc(refPregunta)}</span>
              ${categoria ? `<span class="badge badge--neutro badge--sm">${esc(categoria)}</span>` : ''}
            </span>
            <span class="repaso-contexto-der">
              ${repeticion}
              <span class="badge badge--mayus madurez-${esc(tarjeta.madurez)}">${ETIQUETA_MADUREZ[tarjeta.madurez] || esc(tarjeta.madurez)}</span>
            </span>
          </div>
          <div class="repaso-cuerpo">
            <h2 class="repaso-enunciado">${esc(pregActual.texto)}</h2>
            ${imagenSrc ? `<div class="repaso-media"><img src="${esc(imagenSrc)}" alt="Imagen de la pregunta"></div>` : ''}
            <div class="repaso-opciones" role="group" aria-label="Respuestas">${opcionesHTML}</div>
          </div>
        </article>
        <section class="repaso-confianza" id="repasoConfianza" aria-label="Calibrar confianza" hidden></section>
        <p class="repaso-ayuda" id="repasoAyuda">Pulsa <kbd>1</kbd> <kbd>2</kbd>${numOpciones > 2 ? ' <kbd>3</kbd>' : ''} para responder</p>
        <p class="repaso-aviso-nube" id="repasoAvisoNube" hidden>⚠ No se pudo sincronizar con la nube; el avance está guardado en este dispositivo.</p>
      `;

      stage.querySelectorAll('.opcion--tarjeta').forEach((btn) => {
        btn.addEventListener('click', () => seleccionarOpcion(Number(btn.dataset.op)));
      });
    }

    /**
     * Refleja en el botón de bandera si la pregunta ya tiene una corrección local.
     * @returns {void}
     */
    function actualizarEstadoBandera() {
      const btn = el('btnBandera');
      if (!btn || !claveActual) return;
      const tarjeta = obtenerTarjetas()[claveActual];
      const hayParche = Boolean(tarjeta && typeof obtenerParchePregunta === 'function'
        && obtenerParchePregunta(tarjeta.testId, tarjeta.preguntaIdx));
      btn.classList.toggle('corregida', hayParche);
      btn.title = hayParche ? 'Pregunta ya corregida · editar de nuevo' : 'Corregir esta pregunta';
    }

    /* ---------- Fase 1: elegir respuesta ---------- */
    /**
     * Registra la opción elegida y transiciona de la fase de pregunta a la de confianza.
     * @param {number} i Índice visible de la opción elegida.
     * @returns {void}
     */
    function seleccionarOpcion(i) {
      if (fase !== 'pregunta' || i < 0 || i >= numOpciones) return;
      fase = 'confianza';
      detenerCronometro();               // congela el tiempo exacto al instante
      bloqueoHasta = Date.now() + 200;   // evita que una doble pulsación salte la fase de confianza
      seleccionVisual = i;

      const tarjetaAntes = obtenerTarjetas()[claveActual] || {};
      aciertoActual = i === correctaVisual;
      rachaPrevia = sesion.racha;
      rachaMaxPrevia = sesion.rachaMax;
      tiemposPrevios = tiemposSesion.slice();
      aplicarRacha(aciertoActual, true);
      tiemposSesion.push(tiempoActual);  // entra en la mediana a partir de la SIGUIENTE pregunta

      primeraVezActual = !sesion.vistas.has(claveActual);
      if (primeraVezActual) {
        sesion.vistas.add(claveActual);
        if (Number(tarjetaAntes.ultimoTiempoSeg) > 0) {
          sesion.comparables.add(claveActual);
          if (aciertoActual && tiempoActual < Number(tarjetaAntes.ultimoTiempoSeg)) sesion.mejoradas.add(claveActual);
        }
      }

      mostrarResultado(true);
    }

    /**
     * Actualiza la racha actual y máxima según el resultado de la tarjeta.
     * @param {boolean} acierto Si la respuesta fue correcta.
     * @param {boolean} animar Si se debe animar el cambio.
     * @returns {void}
     */
    function aplicarRacha(acierto, animar) {
      if (acierto) {
        sesion.racha = rachaPrevia + 1;
        sesion.rachaMax = Math.max(sesion.rachaMax, sesion.racha);
        pintarCombo(animar ? 'pop' : null);
      } else {
        sesion.racha = 0;
        pintarCombo(animar && rachaPrevia > 0 ? 'cae' : null);
      }
    }

    /**
     * Revela la respuesta correcta y muestra los niveles de confianza disponibles.
     * @param {boolean} primera Si se muestra por primera vez tras responder.
     * @returns {void}
     */
    function mostrarResultado(primera) {
      const i = seleccionVisual;
      const correcta = correctaVisual;
      const acierto = aciertoActual;
      const tarjetaAntes = obtenerTarjetas()[claveActual] || {};
      const sug = sugerirConfianza(acierto, tiempoActual, tiemposPrevios, tarjetaAntes.tiempoMedioSeg);
      nivelSugerido = sug.nivel;

      cont.querySelectorAll('.opcion--tarjeta').forEach((btn, idx) => {
        btn.classList.add('opcion--bloqueada');
        btn.disabled = true;
        const icono = btn.querySelector('.repaso-opcion-icono');
        if (idx === correcta) {
          btn.classList.add('opcion--correcta');
          if (!acierto) btn.classList.add('opcion--revelada');
          if (icono) icono.innerHTML = ICONO_CHECK;
        } else if (idx === i) {
          btn.classList.add('opcion--fallo');
          if (icono) icono.innerHTML = ICONO_ASPA;
        }
      });

      const intervalos = previsualizarIntervalosTarjeta(claveActual) || {};
      const panel = el('repasoConfianza');
      const hoyStr = hoyISO();
      /**
       * Genera el botón de evaluación para un nivel de confianza.
       * @param {{nivel: string, tecla: string, etiqueta: string}} n Definición del nivel.
       * @returns {string} Fragmento HTML del botón.
       */
      const botonHTML = (n) => {
        const dias = intervalos[n.nivel];
        const fecha = n.nivel !== 'again' && dias > 0 ? fechaCortaISO(sumarDiasISO(hoyStr, dias)) : '';
        return `
        <button type="button" class="repaso-btn-confianza btn-${n.nivel} ${sug.nivel === n.nivel ? 'sugerido' : ''}" data-nivel="${n.nivel}">
          <span class="repaso-btn-linea"><span class="repaso-tecla">${n.tecla}</span> ${n.etiqueta}</span>
          <span class="repaso-btn-dias">${etiquetaIntervalo(n.nivel, dias)}</span>
          ${fecha ? `<span class="repaso-btn-fecha">${esc(fecha)}</span>` : ''}
        </button>`;
      };

      panel.innerHTML = `
        <div class="repaso-confianza-cab">
          <span class="repaso-confianza-titulo">Calibrar confianza</span>
          <span class="badge ${acierto ? 'badge--acierto' : 'badge--fallo'}">${acierto ? '¡Correcto!' : 'Incorrecta'}</span>
        </div>
        <p class="repaso-sugerencia nivel-${sug.nivel}">
          <span class="repaso-sugerencia-tag">Sugerida: ${esc(ETIQUETA_NIVEL[sug.nivel])}</span>
          <span class="repaso-sugerencia-texto">${esc(sug.texto)}</span>
        </p>
        <div class="repaso-confianza-botones">
          ${NIVELES.filter((n) => n.nivel !== 'again').map(botonHTML).join('')}
          <span class="repaso-confianza-sep" aria-hidden="true"></span>
          ${botonHTML(NIVELES.find((n) => n.nivel === 'again'))}
        </div>
      `;
      panel.hidden = false;
      panel.querySelectorAll('.repaso-btn-confianza').forEach((btn) => {
        btn.addEventListener('click', () => calificar(btn.dataset.nivel));
      });

      const ayuda = el('repasoAyuda');
      if (ayuda) ayuda.innerHTML = '<kbd>Espacio</kbd>/<kbd>Enter</kbd> acepta la sugerida y pasa a la siguiente';

      // En pantallas pequeñas asegura que el panel de confianza quede a la vista
      if (primera) {
        requestAnimationFrame(() => {
          panel.scrollIntoView({ behavior: reducirMovimiento() ? 'auto' : 'smooth', block: 'nearest' });
        });
      }
    }

    /**
     * Abre el modal para corregir la tarjeta activa y pausa el cronómetro mientras esté abierto.
     * @returns {void}
     */
    function abrirCorreccionActual() {
      if (!BANDERA_VISIBLE || (fase !== 'pregunta' && fase !== 'confianza') || !pregActual) return;
      const tarjeta = obtenerTarjetas()[claveActual];
      if (!tarjeta) return;
      abrirModalCorreccion({
        testId: Number(tarjeta.testId),
        preguntaIdx: Number(tarjeta.preguntaIdx) || 0,
        pregunta: pregActual,
        alAbrir: () => {
          pausaCorreccion = fase === 'pregunta' && inicioTarjeta !== null ? performance.now() : null;
        },
        alGuardar: (parche, resultado) => {
          aplicarParcheAPregunta(pregActual, parche);
          repintarTarjetaActual();
          actualizarEstadoBandera();
          if (resultado && (resultado.nube === 'error' || resultado.progresoEnNube === false)) {
            const avisoNube = el('repasoAvisoNube');
            if (avisoNube) avisoNube.hidden = false;
          }
        },
        alCerrar: () => {
          if (pausaCorreccion !== null && inicioTarjeta !== null) {
            inicioTarjeta += performance.now() - pausaCorreccion;
          }
          pausaCorreccion = null;
        }
      });
    }

    /**
     * Vuelve a renderizar la tarjeta después de una corrección y recalcula el resultado actual.
     * @returns {void}
     */
    function repintarTarjetaActual() {
      if (!pregActual || (fase !== 'pregunta' && fase !== 'confianza')) return;
      const originalElegida = fase === 'confianza' && seleccionVisual >= 0
        ? ordenVisual[seleccionVisual]
        : -1;
      const cambioNumeroOpciones = numOpciones !== pregActual.opciones.length;

      if (cambioNumeroOpciones) generarOrdenVisual();
      else correctaVisual = ordenVisual.indexOf(pregActual.correcta);
      pintarTarjeta();

      if (fase !== 'confianza') return;
      if (originalElegida < 0 || originalElegida >= pregActual.opciones.length || !ordenVisual.includes(originalElegida)) {
        deshacerRespuestaActual();
        return;
      }

      seleccionVisual = ordenVisual.indexOf(originalElegida);
      const nuevoAcierto = seleccionVisual === correctaVisual;
      if (nuevoAcierto !== aciertoActual) {
        aciertoActual = nuevoAcierto;
        sesion.rachaMax = rachaMaxPrevia;
        aplicarRacha(nuevoAcierto, false);
        const tarjetaAntes = obtenerTarjetas()[claveActual] || {};
        if (sesion.comparables.has(claveActual) && primeraVezActual) {
          if (nuevoAcierto && tiempoActual < Number(tarjetaAntes.ultimoTiempoSeg)) {
            sesion.mejoradas.add(claveActual);
          } else {
            sesion.mejoradas.delete(claveActual);
          }
        }
      }
      mostrarResultado(false);
    }

    /**
     * Revierte la respuesta actual si una corrección hizo inválida la opción elegida.
     * @returns {void}
     */
    function deshacerRespuestaActual() {
      tiemposSesion.pop();
      sesion.racha = rachaPrevia;
      sesion.rachaMax = rachaMaxPrevia;
      pintarCombo(null);
      if (primeraVezActual) {
        sesion.vistas.delete(claveActual);
        sesion.comparables.delete(claveActual);
        sesion.mejoradas.delete(claveActual);
      }
      fase = 'pregunta';
      seleccionVisual = -1;
      nivelSugerido = '';
      aciertoActual = false;
      pausaCorreccion = null;
      inicioTarjeta = performance.now() - (tiempoActual * 1000);
    }

    /* ---------- Fase 2: confianza ---------- */
    /**
     * Persiste la calificación elegida, anima la salida y avanza la sesión.
     * @param {'hard'|'medium'|'easy'|'again'} nivel Calificación seleccionada por el usuario.
     * @returns {Promise<void>}
     * @mermaid
     * ```mermaid
     * flowchart TD
     *   A[Elegir confianza] --> B[Guardar tarjeta Anki]
     *   B --> C[Actualizar contadores del bloque]
     *   C --> D{¿Bloque completo?}
     *   D -- Sí --> E[Mostrar resumen del bloque]
     *   D -- No --> F[Mostrar tarjeta siguiente]
     * ```
     */
    async function calificar(nivel) {
      if (fase !== 'confianza' || Date.now() < bloqueoHasta) return;
      fase = 'guardando';
      const panel = el('repasoConfianza');
      if (panel) panel.classList.add('guardando');
      cont.querySelectorAll('.repaso-btn-confianza').forEach((b) => { b.disabled = true; });

      try {
        await calificarTarjetaAnki(claveActual, nivel, tiempoActual, aciertoActual);   // el botón elegido manda; el tiempo solo es estadística
      } catch (err) {
        console.error('Error calificando la tarjeta:', err);
      }

      sesion.contadores[nivel]++;
      sesion.respondidasBloque++;
      if (aciertoActual) sesion.correctasBloque++;
      sesion.pendientes.shift();
      if (nivel === 'again') {
        // vuelve a salir unos puestos más adelante en esta misma sesión
        sesion.pendientes.splice(Math.min(sesion.pendientes.length, PUESTOS_REENCOLAR), 0, claveActual);
        sesion.repetidas.add(claveActual);
      } else {
        sesion.hechas++;
      }

      // La barra crece mientras la tarjeta actual sale de escena
      actualizarProgreso();
      const stage = el('repasoStage');
      if (stage && !reducirMovimiento()) {
        stage.classList.add('saliendo');
        await new Promise((r) => setTimeout(r, MS_SALIDA));
      }

      if (sesion.respondidasBloque >= TAMANO_BLOQUE_REPASO) {
        mostrarResumenBloque();
        return;
      }

      mostrarTarjeta();
      if (typeof ultimaSincronizacionOk !== 'undefined' && ultimaSincronizacionOk === false) {
        const av = el('repasoAvisoNube');
        if (av) av.hidden = false;
      }
    }

    /**
     * Muestra los aciertos y fallos del bloque y solicita confirmación para continuar.
     * @returns {void}
     */
    function mostrarResumenBloque() {
      fase = 'resumen-bloque';
      const respondidas = sesion.respondidasBloque;
      const correctas = sesion.correctasBloque;
      const fallos = respondidas - correctas;
      const quedanPreguntas = sesion.pendientes.length > 0 || sesion.siguientes.length > 0;
      const porcentaje = respondidas ? Math.round((correctas / respondidas) * 100) : 0;
      const titulo = porcentaje >= 70 ? '¡Muy bien!' : 'Bloque completado';
      const textoBoton = quedanPreguntas ? 'Continuar con las siguientes' : 'Ver resumen de la sesión';

      cont.innerHTML = `
        <section class="repaso-final repaso-bloque-resumen" role="status" aria-live="polite" aria-labelledby="repasoBloqueTitulo">
          <div class="repaso-final-icono">${ICONO_CHECK}</div>
          <p class="badge badge--acierto badge--mayus">Bloque ${sesion.numeroBloque}</p>
          <h2 id="repasoBloqueTitulo">${titulo}</h2>
          <p class="repaso-final-sub">Has respondido ${respondidas} ${respondidas === 1 ? 'pregunta' : 'preguntas'}.</p>
          <div class="repaso-bloque-puntuacion" aria-label="${correctas} correctas de ${respondidas}">
            <strong>${correctas}<span>/${respondidas}</span></strong>
            <span>correctas</span>
          </div>
          <p class="repaso-bloque-detalle">
            ${fallos} ${fallos === 1 ? 'fallo' : 'fallos'} · ${porcentaje} % de aciertos
          </p>
          <button type="button" class="btn btn--primario btn--lg" id="btnContinuarBloque">${textoBoton}</button>
          <a class="repaso-bloque-salir" href="index.html">Ir al panel</a>
        </section>`;
      el('btnContinuarBloque').focus();
    }

    /**
     * Reinicia los contadores de bloque, carga las preguntas siguientes y reanuda el repaso.
     * @param {HTMLButtonElement} boton Botón que inició la continuación.
     * @returns {Promise<void>}
     */
    async function continuarBloque(boton) {
      if (fase !== 'resumen-bloque') return;
      boton.disabled = true;
      sesion.numeroBloque++;
      sesion.respondidasBloque = 0;
      sesion.correctasBloque = 0;

      try {
        if (sesion.siguientes.length) {
          pintarCarga('Cargando las siguientes preguntas...');
          await cargarSiguienteBloquePreguntas();
        }
        mostrarTarjeta();
      } catch (err) {
        console.error('Error cargando el siguiente bloque de preguntas:', err);
        pintarAviso('No se pudieron cargar las siguientes preguntas. Comprueba tu conexión e inténtalo de nuevo.');
      }
    }

    /* ---------- Pantalla final ---------- */
    /**
     * Espera la persistencia pendiente, sincroniza flags y presenta el resumen de sesión.
     * @returns {Promise<void>}
     * @mermaid
     * ```mermaid
     * sequenceDiagram
     *   participant UI as Repaso
     *   participant Store as storage.js
     *   UI->>Store: esperarGuardadoProgreso()
     *   UI->>Store: sincronizarFlagsSesion()
     *   Store-->>UI: resultado de sincronización
     *   UI->>UI: renderizar resumen y avisos
     * ```
     */
    async function mostrarFinal() {
      fase = 'finalizando';
      let falloSincronizacionFlags = false;
      let falloSincronizacionProgreso = false;
      try {
        falloSincronizacionProgreso = !(await esperarGuardadoProgreso());
      } catch (err) {
        console.error('Error esperando la sincronización del progreso:', err);
        falloSincronizacionProgreso = true;
      }
      try {
        const resultado = await sincronizarFlagsSesion();
        falloSincronizacionFlags = !resultado.ok;
      } catch (err) {
        console.error('Error sincronizando correcciones de la sesión:', err);
        falloSincronizacionFlags = true;
      }

      fase = 'final';
      const e = obtenerColaRepasoHoy();
      const c = sesion ? sesion.contadores : { hard: 0, medium: 0, easy: 0, again: 0 };
      const repasadas = sesion ? sesion.hechas : 0;
      const rachaMax = sesion ? sesion.rachaMax : 0;
      const hayMas = MODO === 'repaso' && e.colaHoy.length > 0;
      const tema = MODO === 'tema' ? obtenerTemaDGT(TEMA_ID) : null;

      // Categorías más flojas según el historial real (mayor % de fallos)
      const debiles = typeof obtenerCategoriasDebiles === 'function' ? obtenerCategoriasDebiles(3) : [];
      const bloqueDebiles = debiles.length ? `
        <div class="repaso-debiles">
          <h3 class="repaso-debiles-titulo">Categorías a reforzar</h3>
          <ul class="repaso-debiles-lista">
            ${debiles.map((c) => {
              const pct = Math.round(c.tasaFallo * 100);
              return `
              <li class="repaso-debil-item">
                <span class="repaso-debil-nombre">${esc(c.categoria)}</span>
                <span class="repaso-debil-barra" aria-hidden="true"><span style="width:${pct}%"></span></span>
                <span class="repaso-debil-pct">${pct} % de fallos</span>
              </li>`;
            }).join('')}
          </ul>
        </div>` : '';

      // Resumen de tiempos de la sesión vs. límite oficial del examen (60 s/pregunta)
      let bloqueTiempos = '';
      if (tiemposSesion.length) {
        const nMejoradas = sesion ? sesion.mejoradas.size : 0;
        const nComparables = sesion ? sesion.comparables.size : 0;
        const textoMejora = nComparables === 0
          ? 'Aún no hay tiempos previos con los que comparar: en tu próximo repaso verás cuánto mejoras.'
          : nMejoradas > 0
            ? `⚡ ${nMejoradas} ${nMejoradas === 1 ? 'tarjeta respondida' : 'tarjetas respondidas'} más rápido que en tu anterior repaso (de ${nComparables} con historial)`
            : `Ninguna tarjeta más rápida que en tu anterior repaso (${nComparables} con historial)`;
        const mediana = calcularMediana(tiemposSesion);
        const media = tiemposSesion.reduce((a, b) => a + b, 0) / tiemposSesion.length;
        const pct = Math.min(100, Math.round((media / TOPE_TIEMPO_SEG) * 100));
        bloqueTiempos = `
          <div class="repaso-tiempos">
            <div class="repaso-tiempos-fila">
              <div class="repaso-tiempo-item"><strong>${fmtSeg(mediana)}</strong><span>Mediana de hoy</span></div>
              <div class="repaso-tiempo-item"><strong>${fmtSeg(media)}</strong><span>Media por pregunta</span></div>
              <div class="repaso-tiempo-item limite"><strong>${TOPE_TIEMPO_SEG}s</strong><span>Límite DGT</span></div>
            </div>
            <div class="repaso-tiempos-barra" aria-hidden="true"><div class="repaso-tiempos-relleno" style="width:${pct}%"></div></div>
            <p class="repaso-tiempos-mejora ${nMejoradas > 0 ? 'hay-mejora' : ''}">${textoMejora}</p>
            <p class="repaso-tiempos-nota">Usas de media el ${pct} % del tiempo por pregunta del examen (${tiemposSesion.length} ${tiemposSesion.length === 1 ? 'respuesta' : 'respuestas'} cronometradas).</p>
          </div>`;
      }

      cont.innerHTML = `
        <div class="repaso-final">
          <div class="repaso-final-icono" aria-hidden="true">✓</div>
          <h2>${MODO === 'tema'
            ? repasadas ? `¡Tema ${esc(tema.titulo)} completado!` : `No hay preguntas disponibles en ${esc(tema.titulo)}`
            : MODO === 'falladas'
            ? repasadas ? '¡Repaso de falladas completado!' : 'No tienes preguntas falladas'
            : repasadas ? '¡Repaso de hoy completado!' : '¡Estás al día!'}</h2>
          <p class="repaso-final-sub">${repasadas
            ? `Has repasado ${repasadas} ${repasadas === 1 ? 'tarjeta' : 'tarjetas'} (${c.again} ${c.again === 1 ? 'repetición' : 'repeticiones'} por «Again»).`
            : MODO === 'tema' ? `No hay preguntas clasificadas en el tema ${esc(tema.titulo)}.`
              : MODO === 'falladas' ? 'No hay preguntas con fallos anteriores en tu mazo.' : 'No tienes tarjetas pendientes para hoy.'}</p>
          ${rachaMax > 0 ? `<div class="badge badge--aviso badge--lg repaso-racha-final">🔥 Mejor racha: ${rachaMax}</div>` : ''}
          <div class="repaso-resumen">
            <div class="repaso-resumen-item madurez-nueva"><strong>${e.nuevas}</strong><span>Nuevas</span></div>
            <div class="repaso-resumen-item madurez-aprendiendo"><strong>${e.aprendiendo}</strong><span>Aprendiendo</span></div>
            <div class="repaso-resumen-item madurez-joven"><strong>${e.jovenes}</strong><span>Jóvenes</span></div>
            <div class="repaso-resumen-item madurez-madura"><strong>${e.maduras}</strong><span>Maduras</span></div>
          </div>
          ${bloqueTiempos}
          ${bloqueDebiles}
          ${falloSincronizacionProgreso ? '<p class="repaso-aviso-nube" role="status">⚠ No se pudo sincronizar todo el progreso; sigue guardado en este dispositivo.</p>' : ''}
          ${falloSincronizacionFlags ? '<p class="repaso-aviso-nube" role="status">⚠ No se pudieron enviar todas las correcciones; siguen guardadas en este dispositivo.</p>' : ''}
          <p class="repaso-final-sub">${e.totalMazo} preguntas en seguimiento · examen en ${e.diasRestantes} ${e.diasRestantes === 1 ? 'día' : 'días'}</p>
          ${hayMas ? `<a class="btn btn--contorno btn--lg" href="test.html?modo=repaso">Seguir con ${e.colaHoy.length} ${e.colaHoy.length === 1 ? 'tarjeta más' : 'tarjetas más'}</a>` : ''}
          <a class="btn btn--primario btn--lg" href="index.html">Volver al panel <kbd>Enter</kbd></a>
        </div>
      `;
    }

    cont.addEventListener('click', (event) => {
      const botonBandera = event.target.closest && event.target.closest('#btnBandera');
      if (botonBandera) {
        abrirCorreccionActual();
        return;
      }

      const botonContinuar = event.target.closest && event.target.closest('#btnContinuarBloque');
      if (botonContinuar) {
        continuarBloque(botonContinuar);
        return;
      }

      const salir = event.target.closest && event.target.closest('#repasoSalir');
      if (salir) {
        event.preventDefault();
        salir.setAttribute('aria-disabled', 'true');
        Promise.all([sincronizarFlagsSesion(), esperarGuardadoProgreso()])
        .then(([resultadoFlags, progresoOk]) => {
          if (!resultadoFlags.ok) throw new Error('Supabase no confirmó el envío de las correcciones.');
          if (!progresoOk) throw new Error('El progreso pendiente no se pudo guardar en la nube.');
          window.location.assign(salir.href);
        })
        .catch((err) => {
          console.error('Error guardando los cambios antes de salir:', err);
          salir.removeAttribute('aria-disabled');
          const aviso = el('repasoAvisoNube');
          if (aviso) {
            aviso.textContent = 'No se pudieron enviar las correcciones a la nube. Siguen guardadas en este dispositivo; pulsa salir para reintentar.';
            aviso.textContent += mensajeErrorSincronizacion(err);
            aviso.hidden = false;
          }
        });
      }
    });

    /* ---------- Teclado ---------- */
    document.addEventListener('keydown', (e) => {
      if (modalCorreccionAbierto) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;

      if (fase === 'pregunta') {
        const i = ['1', '2', '3'].indexOf(e.key);
        if (i >= 0 && i < numOpciones) { e.preventDefault(); seleccionarOpcion(i); }
      } else if (fase === 'confianza') {
        const nivel = TECLA_A_NIVEL[e.key];
        if (nivel) { e.preventDefault(); calificar(nivel); }
        else if ((e.key === ' ' || e.key === 'Enter') && nivelSugerido) { e.preventDefault(); calificar(nivelSugerido); }
      } else if (fase === 'resumen-bloque' && e.key === 'Enter') {
        const boton = el('btnContinuarBloque');
        if (boton) { e.preventDefault(); continuarBloque(boton); }
      } else if (fase === 'final' && e.key === 'Enter') {
        window.location.href = 'index.html';
      }
    });

    /* ---------- Arranque ---------- */
    /**
     * Prepara los datos y el mazo antes de mostrar la primera tarjeta de repaso.
     * @returns {Promise<void>}
     */
    (async function arrancar() {
      pintarCarga('Cargando tu progreso...');
      try {
        await sincronizacionInicial;
        if (MODO === 'tema') {
          if (!obtenerTemaDGT(TEMA_ID)) {
            pintarAviso('El tema indicado no existe o no está disponible.');
            return;
          }
          pintarCarga('Preparando las preguntas del tema…');
          await asegurarCategoriasDGT();
        } else if (necesitaInicializarMazo()) {
          pintarCarga('Preparando mazo Anki...');
          await inicializarMazoAnkiDesdeTests();
        } else {
          pintarCarga('Buscando tests nuevos...');
          await sincronizarTestsSiToca();
        }
      } catch (err) {
        console.error('Error preparando el mazo:', err);
        pintarAviso(MODO === 'tema'
          ? 'No se pudieron preparar las preguntas de este tema. Comprueba tu conexión y que los tests estén en <code>data/</code>.'
          : 'No se pudo preparar el mazo Anki. Comprueba tu conexión y que los tests estén en <code>data/</code>.');
        return;
      }

      const estado = obtenerColaRepasoHoy();
      if (!estado.totalMazo) {
        pintarAviso('No se encontró ningún test con respuestas en <code>data/</code>, así que el mazo está vacío.');
        return;
      }

      sesion = {
        pendientes: [], siguientes: [], total: 0, hechas: 0,
        numeroBloque: 1, respondidasBloque: 0, correctasBloque: 0,
        contadores: { hard: 0, medium: 0, easy: 0, again: 0 },
        repetidas: new Set(),
        racha: 0, rachaMax: 0,
        vistas: new Set(), comparables: new Set(), mejoradas: new Set()
      };
      const colaInicial = MODO === 'falladas'
        ? Object.entries(obtenerTarjetas())
          .filter(([, tarjeta]) => Number(tarjeta.fallos) > 0)
          .map(([clave, tarjeta]) => ({ clave, ...tarjeta }))
        : MODO === 'tema'
          ? obtenerColaPorTema(TEMA_ID)
        : estado.colaHoy;
      if (!colaInicial.length) { mostrarFinal(); return; }

      sesion.siguientes = colaInicial.map((t) => t.clave);
      sesion.total = sesion.siguientes.length;
      pintarCarga(`Cargando las primeras ${Math.min(TAMANO_BLOQUE_REPASO, sesion.total)} preguntas...`);
      await cargarSiguienteBloquePreguntas();
      mostrarTarjeta();
    })();
  }

  /* ================= ARRANQUE ================= */
  /**
   * Selecciona el modo de ejecución y carga el test tradicional cuando corresponda.
   * @returns {Promise<void>}
   */
  (async function iniciar() {
    if (MODO === 'repaso' || MODO === 'falladas' || MODO === 'tema') {
      iniciarRepaso();
      return;
    }

    const n = obtenerIdTest();
    if (n === null) {
      document.title = 'Test · dgt-eando';
      if (tituloNum) tituloNum.textContent = '';
      mostrarAviso('<strong>No se ha indicado qué test abrir.</strong><br>' +
        'Falta el parámetro <code>id</code> en la URL (por ejemplo <code>test.html?id=070&amp;modo=examen</code>).');
      return;
    }

    window.TEST_ID = n;
    document.title = `Test nº ${n}`;
    if (tituloNum) tituloNum.textContent = `nº ${n}`;

    try {
      const data = await cargarJSONTest(n);
      await sincronizacionInicial;
      aplicarParchesATest(n, data);
      PREGUNTAS = preguntasDeDatosTest(data) || [];
      if (!PREGUNTAS.length) throw new Error('El JSON no contiene preguntas');
      BANDERA_TEST_VISIBLE = PREGUNTAS.length >= 29;
      if (btnAnadirPregunta) btnAnadirPregunta.hidden = false;
      renderPreguntas();
    } catch (err) {
      console.error('Error cargando el test:', err);
      mostrarAviso(`<strong>No se pudo cargar el test nº ${n}.</strong><br>` +
        'Comprueba que existe el archivo <code>data/test_' + String(n).padStart(3, '0') + '.json</code> ' +
        '(o <code>data/test_' + n + '.json</code>).');
    }
  })();
})();
