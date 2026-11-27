/**
 * @module
 * @remarks
 * Renderiza el panel principal de tests y las interfaces de seguimiento del examen y configuración de repaso Anki.
 * Importa explícitamente sus dependencias de storage.js.
 *
 * @typedef {Object} ResumenRachaEstudio
 * @property {number} dias Días consecutivos de actividad.
 * @property {boolean} practicoHoy Indica si se ha practicado durante el día actual.
 * @typedef {Object} ResumenColaAnki
 * @property {number} cuotaDiaria Tarjetas pendientes para la sesión de hoy.
 * @property {number} totalMazo Total de preguntas incluidas en el mazo.
 * @property {number} nuevas Tarjetas nuevas del mazo.
 * @property {number} aprendiendo Tarjetas en fase de aprendizaje.
 * @property {number} jovenes Tarjetas con intervalos de repaso cortos.
 * @property {number} maduras Tarjetas con intervalos de repaso largos.
 * @typedef {Object} HistorialIntentoTest
 * @property {number} [intento] Número de intento registrado.
 * @property {string} [fecha] Fecha legible del intento.
 * @property {number|string} fallos Número de fallos del intento.
 * @typedef {Object} ConfiguracionAnkiFormulario
 * @property {string} modoLimite Modo de cálculo del límite diario.
 * @property {number} limiteDiario Máximo de tarjetas diarias.
 * @property {number} limiteNuevas Máximo de tarjetas nuevas; cero significa sin límite.
 * @property {string} orden Criterio de orden de las tarjetas.
 * @property {boolean} barajarOpciones Indica si se barajan las opciones.
 * @property {boolean} limiteEstricto Indica si se aplica estrictamente el límite diario.
 */

import {
  borrarProgreso,
  asegurarCategoriasDGT,
  calcularRachaEstudio,
  exportarJSON,
  guardarConfigAnki,
  guardarFechaExamen,
  importarJSON,
  necesitaInicializarMazo,
  obtenerColaRepasoHoy,
  obtenerColaPorTema,
  obtenerConfigAnki,
  obtenerFechaExamen,
  obtenerHistorialTest,
  obtenerProgreso,
  reiniciarProgresoAnki,
  sincronizarDesdeNube,
  sincronizarNuevosTestsAlMazo,
  sincronizarTestsSiToca
} from './storage.js?v=12';
import { TEMAS_DGT } from './categorias.js?v=1';

/** @type {number} Número total de tests mostrados en el panel. */
const TOTAL_TESTS = 90;
/** @type {Chart|null} Instancia activa de la gráfica de evolución de fallos. */
let chartInstancia = null;

/**
 * Formatea el número de veces que se ha realizado un test.
 * @param {number} n Número de intentos.
 * @returns {string} Número con su unidad, o un guion si no hay intentos.
 */
function formatearVeces(n) {
  if (!n || n <= 0) return '-';
  return n === 1 ? '1 vez' : `${n} veces`;
}

/**
 * Lee el modo seleccionado en el formulario de la página.
 * @returns {string} Modo seleccionado o `examen` si no hay ninguna opción marcada.
 */
function obtenerModoSeleccionado() {
  const sel = document.querySelector('input[name="modo"]:checked');
  return sel ? sel.value : 'examen';
}

/* ================= RENDER DE WIDGETS LATERALES ================= */
/**
 * Convierte una fecha ISO `AAAA-MM-DD` a una fecha abreviada en español.
 * @param {string} fechaISO Fecha con formato ISO.
 * @returns {string} Fecha formateada; si el formato no es válido, devuelve la entrada.
 */
function formatearFechaEspanol(fechaISO) {
  const partes = fechaISO.split('-');
  if (partes.length !== 3) return fechaISO;
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const anio = partes[0];
  const mesIdx = parseInt(partes[1], 10) - 1;
  const dia = parseInt(partes[2], 10);
  return `${dia} ${meses[mesIdx] || partes[1]} ${anio}`;
}

/**
 * Actualiza el contador y la fecha del examen en el panel.
 * @returns {void}
 */
function renderContadorExamen() {
  const fechaISO = obtenerFechaExamen();
  const inputFecha = document.getElementById('inputFechaExamen');
  if (inputFecha && document.activeElement !== inputFecha) {
    inputFecha.value = fechaISO;
  }

  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fechaObjetivo = new Date(anio, mes - 1, dia);
  fechaObjetivo.setHours(0, 0, 0, 0);

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  const diffMs = fechaObjetivo.getTime() - hoy.getTime();
  const diffDias = Math.round(diffMs / (1000 * 60 * 60 * 24));

  const diasNum = document.getElementById('examenDiasNum');
  const diasEtiqueta = document.getElementById('examenDiasEtiqueta');
  const subFecha = document.getElementById('examenFechaFormateada');
  const btnFecha = document.getElementById('btnFechaExamen');

  if (diffDias > 0) {
    diasNum.textContent = diffDias;
    diasEtiqueta.textContent = diffDias === 1 ? 'día restante' : 'días restantes';
  } else if (diffDias === 0) {
    diasNum.textContent = '¡Hoy!';
    diasEtiqueta.textContent = 'es el examen';
  } else {
    diasNum.textContent = 'Examen';
    diasEtiqueta.textContent = 'finalizado';
  }

  subFecha.textContent = formatearFechaEspanol(fechaISO);
  btnFecha.setAttribute('aria-label', `Cambiar fecha del examen: ${subFecha.textContent}`);
}

/**
 * Actualiza el indicador de días consecutivos de estudio.
 * @returns {void}
 */
function renderRachaEstudio() {
  /** @type {ResumenRachaEstudio} */
  const { dias, practicoHoy } = calcularRachaEstudio();
  const rachaTexto = document.getElementById('rachaDiasTexto');
  const rachaContexto = document.getElementById('rachaContexto');
  const rachaUnidad = document.getElementById('rachaUnidad');
  const rachaMensaje = document.getElementById('rachaMensaje');
  const rachaBadge = document.getElementById('rachaBadge');
  rachaTexto.textContent = dias;
  rachaUnidad.textContent = dias === 1 ? 'día' : 'días';
  const descripcion = dias === 0
    ? 'Sin racha activa'
    : `${dias} ${dias === 1 ? 'día' : 'días'} de racha${practicoHoy ? ', con práctica hoy' : ''}`;
  rachaContexto.setAttribute('aria-label', descripcion);
  rachaContexto.title = descripcion;

  if (dias === 0) {
    rachaMensaje.textContent = 'Completa un test hoy para encender tu racha diaria.';
    rachaBadge.textContent = 'Sin racha activa';
    rachaBadge.classList.remove('completado');
  } else if (practicoHoy) {
    rachaMensaje.textContent = '¡Gran ritmo! Ya has sumado práctica en el día de hoy.';
    rachaBadge.textContent = 'Objetivo de hoy cumplido';
    rachaBadge.classList.add('completado');
  } else {
    rachaMensaje.textContent = 'Haz al menos un test hoy para no perder tu racha.';
    rachaBadge.textContent = 'Pendiente hoy';
    rachaBadge.classList.remove('completado');
  }
}

/* ================= REPASO INTELIGENTE (ANKI) ================= */
/**
 * Actualiza el resumen del mazo Anki y el acceso al repaso de hoy.
 * No realiza cambios si el almacenamiento Anki no está disponible en la página.
 * @returns {void}
 */
function renderAnki() {
  if (typeof obtenerColaRepasoHoy !== 'function') return;

  /** @type {ResumenColaAnki} */
  const estado = obtenerColaRepasoHoy();
  const num = document.getElementById('ankiCuotaNum');
  const etiqueta = document.getElementById('ankiCuotaEtiqueta');
  const total = document.getElementById('ankiTotalSeguimiento');
  const desglose = document.getElementById('ankiDesglose');
  const btnDetalle = document.getElementById('btnVerDetalle');
  const btn = document.getElementById('btnRepasoAnki');
  const badge = document.getElementById('ankiBadgeAlDia');
  if (!num || !etiqueta || !total || !desglose || !btnDetalle || !btn || !badge) return;

  const n = estado.cuotaDiaria;
  num.textContent = n;
  etiqueta.textContent = n === 1 ? 'tarjeta para hoy' : 'tarjetas para hoy';
  total.textContent = estado.totalMazo === 1
    ? '1 en seguimiento'
    : `${estado.totalMazo} en seguimiento`;
  desglose.textContent = estado.totalMazo
    ? `${estado.nuevas} nuevas · ${estado.aprendiendo} aprendiendo · ${estado.jovenes} jóvenes · ${estado.maduras} maduras`
    : '';
  btnDetalle.hidden = estado.totalMazo === 0;

  btn.href = 'test.html?modo=repaso';

  if (estado.totalMazo === 0 || necesitaInicializarMazo()) {
    // Mazo sin crear: el primer repaso carga los tests de data/ y lo inicializa
    btn.textContent = 'Iniciar mazo Anki (cargar tests)';
    btn.hidden = false;
    badge.hidden = true;
  } else if (n > 0) {
    btn.textContent = `Repasar ${n} ${n === 1 ? 'tarjeta' : 'tarjetas'} hoy`;
    btn.hidden = false;
    badge.hidden = true;
  } else {
    btn.hidden = true;
    badge.textContent = '¡Al día! 0 tarjetas pendientes';
    badge.hidden = false;
  }
}

/**
 * Renderiza todos los componentes principales del panel.
 * @returns {void}
 */
function renderDashboard() {
  renderTabla();
  renderContadorExamen();
  renderRachaEstudio();
  renderAnki();
}

/* ================= VISTA DE TEMAS ================= */
const dashboardPrincipal = document.getElementById('dashboardPrincipal');
const vistaTemas = document.getElementById('vista-temas');
const listaTemas = document.getElementById('listaTemas');
const estadoTemas = document.getElementById('estadoTemas');
const btnAbrirTemas = document.getElementById('btnAbrirTemas');
const btnVolverPanel = document.getElementById('btnVolverPanel');
let cargaTemasEnCurso = null;
let secuenciaTransicionVista = 0;

/**
 * Escapa texto del catálogo antes de interpolarlo en el HTML de la vista.
 * @param {*} valor Valor del catálogo.
 * @returns {string} Texto seguro para HTML.
 */
function escaparHTML(valor) {
  return String(valor).replace(/[&<>"']/g, (caracter) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[caracter]));
}

/**
 * Renderiza las tarjetas temáticas y actualiza sus contadores después de migrar el mazo.
 * @returns {Promise<void>}
 */
async function renderTemas() {
  const temas = TEMAS_DGT.filter((tema) => tema.activo);
  listaTemas.innerHTML = temas.map((tema) => `
    <a class="card tema-card" href="test.html?modo=tema&amp;tema=${encodeURIComponent(tema.id)}" data-tema-id="${escaparHTML(tema.id)}">
      <div class="widget-icon-green tema-card-icono" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M8 4v16M16 4v16M4 10h16M4 15h16"/></svg>
      </div>
      <div class="tema-card-contenido">
        <h3 class="tema-card-titulo">${escaparHTML(tema.titulo)}</h3>
        <p class="tema-card-descripcion">${escaparHTML(tema.descripcion)}</p>
        <span class="badge badge--contorno tema-card-contador" data-tema-contador="${escaparHTML(tema.id)}">Cargando preguntas…</span>
      </div>
    </a>
  `).join('');
  estadoTemas.textContent = 'Actualizando categorías del mazo…';

  try {
    if (!cargaTemasEnCurso) {
      cargaTemasEnCurso = (async () => {
        await sincronizarDesdeNube();
        const migracion = await asegurarCategoriasDGT();
        if (!migracion.totalMazo) throw new Error('No se pudieron cargar preguntas para clasificar.');
        return migracion;
      })();
    }
    await cargaTemasEnCurso;
    temas.forEach((tema) => {
      const contador = listaTemas.querySelector(`[data-tema-contador="${tema.id}"]`);
      if (contador) contador.textContent = `${obtenerColaPorTema(tema.id).length} preguntas disponibles`;
    });
    estadoTemas.textContent = '';
  } catch (error) {
    console.error('Error preparando el catálogo de temas:', error);
    estadoTemas.textContent = 'No se pudieron cargar las preguntas de los temas. Vuelve a intentarlo.';
    cargaTemasEnCurso = null;
  }
}

/**
 * Cambia entre el Dashboard y el catálogo de temas con una transición reversible.
 * @param {boolean} mostrarTemas Indica si se debe mostrar el catálogo.
 * @returns {void}
 */
function cambiarVistaTemas(mostrarTemas) {
  const saliente = mostrarTemas ? dashboardPrincipal : vistaTemas;
  const entrante = mostrarTemas ? vistaTemas : dashboardPrincipal;
  if (entrante.hidden === false && saliente.hidden) return;
  const secuencia = ++secuenciaTransicionVista;

  entrante.hidden = false;
  entrante.setAttribute('aria-hidden', 'false');
  saliente.setAttribute('aria-hidden', 'true');
  void entrante.offsetWidth;
  requestAnimationFrame(() => {
    if (secuencia !== secuenciaTransicionVista) return;
    entrante.classList.add('es-visible');
    saliente.classList.remove('es-visible');
    (mostrarTemas ? btnVolverPanel : btnAbrirTemas).focus();
  });

  const terminar = (event) => {
    if (event.target !== saliente || event.propertyName !== 'opacity') return;
    saliente.removeEventListener('transitionend', terminar);
    if (secuencia === secuenciaTransicionVista) saliente.hidden = true;
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    requestAnimationFrame(() => {
      if (secuencia === secuenciaTransicionVista) saliente.hidden = true;
    });
  } else {
    saliente.addEventListener('transitionend', terminar);
  }
}

btnAbrirTemas.addEventListener('click', () => {
  cambiarVistaTemas(true);
  if (!cargaTemasEnCurso || estadoTemas.textContent) renderTemas();
});
btnVolverPanel.addEventListener('click', () => cambiarVistaTemas(false));
document.querySelectorAll('.practica-chip').forEach((chip) => {
  chip.addEventListener('click', () => btnAbrirTemas.click());
});

const btnVerDetalle = document.getElementById('btnVerDetalle');
const ankiDetalleWrap = document.getElementById('ankiDetalleWrap');
btnVerDetalle.addEventListener('click', () => {
  const expandido = btnVerDetalle.getAttribute('aria-expanded') !== 'true';
  btnVerDetalle.setAttribute('aria-expanded', String(expandido));
  btnVerDetalle.textContent = expandido ? 'Ocultar detalle' : 'Ver detalle';
  ankiDetalleWrap.setAttribute('aria-hidden', String(!expandido));
  ankiDetalleWrap.classList.toggle('abierto', expandido);
});

/* ================= INTERACCIÓN EDITOR FECHA EXAMEN ================= */
const editorInline = document.getElementById('examenEditorInline');
const btnFechaExamen = document.getElementById('btnFechaExamen');
const btnGuardarFecha = document.getElementById('btnGuardarFecha');
const inputFechaExamen = document.getElementById('inputFechaExamen');

/**
 * Abre o cierra el editor de la fecha del examen.
 * @param {boolean} [forzarEstado] Si se proporciona, fuerza la apertura (`true`) o el cierre (`false`).
 * @returns {void}
 */
function toggleEditorFecha(forzarEstado) {
  const abrir = typeof forzarEstado === 'boolean'
    ? forzarEstado
    : !editorInline.classList.contains('abierto');

  if (abrir) {
    inputFechaExamen.value = obtenerFechaExamen();
    editorInline.classList.add('abierto');
    btnFechaExamen.setAttribute('aria-expanded', 'true');
    setTimeout(() => inputFechaExamen.focus(), 30);
  } else {
    editorInline.classList.remove('abierto');
    btnFechaExamen.setAttribute('aria-expanded', 'false');
  }
}

btnFechaExamen.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleEditorFecha();
});

btnGuardarFecha.addEventListener('click', async (e) => {
  e.stopPropagation();
  const val = inputFechaExamen.value;
  if (!val) return;
  await guardarFechaExamen(val);
  renderContadorExamen();
  toggleEditorFecha(false);
});

/* ================= RENDER DE LA TABLA DE TESTS ================= */
/**
 * Construye la lista de tests con su estado, resultados y enlace al modo actual.
 * @returns {void}
 */
function renderTabla() {
  const progreso = obtenerProgreso();
  const modo = obtenerModoSeleccionado();
  const contenedor = document.getElementById('listaTests');
  contenedor.innerHTML = '';

  for (let i = 1; i <= TOTAL_TESTS; i++) {
    const numStr = String(i).padStart(3, '0');
    const clave = `test_${numStr}`;
    const datos = progreso[clave];

    const realizado = datos ? datos.intentos : 0;
    const fallos = realizado > 0 ? datos.fallos : '-';
    const ultimo = realizado > 0 ? datos.ultimo : '-';

    let claseEstado = 'estado-pendiente';
    if (realizado > 0) {
      claseEstado = datos.fallos <= 3 ? 'estado-aprobado' : 'estado-suspenso';
    }

    const enlace = document.createElement('a');
    enlace.className = 'fila-test';
    enlace.dataset.num = numStr;
    enlace.href = `test.html?id=${numStr}&modo=${modo}`;

    const celdaFallosHTML = realizado > 0
      ? `<div class="celda-fallos clickable" title="Ver evolución de fallos">
           <span class="fallos-valor">
             ${fallos}
             <svg class="icono-grafica" viewBox="0 0 24 24">
               <polyline points="3 17 9 11 13 15 21 7"></polyline>
               <polyline points="14 7 21 7 21 14"></polyline>
             </svg>
           </span>
         </div>`
      : `<div class="celda-fallos">-</div>`;

    enlace.innerHTML = `
      <div class="celda-num">${numStr}</div>
      <div class="celda-estado"><span class="cuadro-estado ${claseEstado}"></span></div>
      ${celdaFallosHTML}
      <div>${formatearVeces(realizado)}</div>
      <div>${ultimo}</div>
      <div class="celda-flecha">
        <svg viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"></polyline></svg>
      </div>
    `;

    if (realizado > 0) {
      const celdaFallos = enlace.querySelector('.celda-fallos');
      celdaFallos.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        abrirGraficaTest(numStr);
      });
    }

    contenedor.appendChild(enlace);
  }
}

/**
 * Actualiza los enlaces de cada test para que reflejen el modo seleccionado.
 * @returns {void}
 */
function actualizarEnlaces() {
  const modo = obtenerModoSeleccionado();
  document.querySelectorAll('.fila-test').forEach(a => {
    a.href = `test.html?id=${a.dataset.num}&modo=${modo}`;
  });
}

/* ================= MODAL Y CHART.JS ================= */
/** @type {Object} Plugin que dibuja el umbral de aprobado. */
const lineaLimitePlugin = {
  id: 'lineaLimiteAprobado',
  /**
   * Dibuja en la gráfica la línea horizontal que marca el máximo de fallos aprobado.
   * @param {import('chart.js').Chart} chart Instancia de Chart.js que se está dibujando.
   * @returns {void}
   */
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea: { left, right }, scales: { y } } = chart;
    if (!y) return;
    const yPos = y.getPixelForValue(3);

    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(107, 114, 128, 0.7)';
    ctx.moveTo(left, yPos);
    ctx.lineTo(right, yPos);
    ctx.stroke();
    ctx.restore();
  }
};

/**
 * Abre la gráfica de evolución de fallos de un test.
 * @param {string} numStr Número de test con el formato usado en sus claves de progreso.
 * @returns {void}
 */
function abrirGraficaTest(numStr) {
  const clave = `test_${numStr}`;
  /** @type {HistorialIntentoTest[]} */
  const historial = typeof obtenerHistorialTest === 'function' ? obtenerHistorialTest(clave) : [];

  document.getElementById('modalTitulo').textContent = `Evolución Test ${numStr}`;
  const modal = document.getElementById('modalGrafica');
  modal.classList.add('activo');

  const etiquetas = historial.map((item, idx) => {
    const numIntento = item.intento || (idx + 1);
    const fecha = item.fecha || '';
    return fecha ? `#${numIntento} (${fecha})` : `#${numIntento}`;
  });

  const valoresFallos = historial.map(item => Number(item.fallos) || 0);

  const coloresPuntos = valoresFallos.map(f => f <= 3 ? '#8bc34a' : '#f66e6e');
  const bordesPuntos = valoresFallos.map(f => f <= 3 ? '#558b2f' : '#d32f2f');

  const maxFallos = valoresFallos.length ? Math.max(...valoresFallos) : 0;
  const sugeridoMax = Math.max(5, maxFallos + 1);

  if (chartInstancia) {
    chartInstancia.destroy();
    chartInstancia = null;
  }

  const ctx = document.getElementById('canvasEvolucion').getContext('2d');
  chartInstancia = new Chart(ctx, {
    type: 'line',
    data: {
      labels: etiquetas,
      datasets: [{
        label: 'Fallos',
        data: valoresFallos,
        borderColor: '#367cb8',
        backgroundColor: 'rgba(54, 124, 184, 0.12)',
        borderWidth: 2,
        tension: 0.25,
        fill: true,
        pointBackgroundColor: coloresPuntos,
        pointBorderColor: bordesPuntos,
        pointBorderWidth: 2,
        pointRadius: 6,
        pointHoverRadius: 8,
        pointHitRadius: 16
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
      interaction: {
        mode: 'nearest',
        intersect: false
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          enabled: true,
          backgroundColor: 'rgba(31, 41, 55, 0.95)',
          titleFont: { size: 13, weight: '600' },
          bodyFont: { size: 13 },
          padding: 10,
          cornerRadius: 6,
          displayColors: true,
          callbacks: {
            /**
             * Obtiene el título del tooltip a partir de la etiqueta del punto.
             * @param {Array<{label: string}>} context Elementos de contexto del tooltip.
             * @returns {string} Etiqueta del punto seleccionado.
             */
            title(context) {
              return context[0].label;
            },
            /**
             * Describe los fallos y el resultado del punto del tooltip.
             * @param {{parsed: {y: number}}} context Contexto del punto del tooltip.
             * @returns {string} Texto con el número de fallos y el estado del test.
             */
            label(context) {
              const val = context.parsed.y;
              const estado = val <= 3 ? 'Aprobado' : 'Suspenso';
              return ` Fallos: ${val} (${estado})`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: '#6b7280',
            font: { size: 11 },
            maxRotation: 35,
            minRotation: 0
          }
        },
        y: {
          beginAtZero: true,
          suggestedMax: sugeridoMax,
          ticks: {
            stepSize: 1,
            precision: 0,
            color: '#6b7280',
            font: { size: 12 }
          },
          grid: {
            color: '#f3f4f6'
          }
        }
      }
    },
    plugins: [lineaLimitePlugin]
  });
}

/**
 * Cierra el modal de evolución de la gráfica.
 * @returns {void}
 */
function cerrarModalGrafica() {
  document.getElementById('modalGrafica').classList.remove('activo');
}

document.getElementById('btnCerrarModal').addEventListener('click', cerrarModalGrafica);

document.getElementById('modalGrafica').addEventListener('click', (e) => {
  if (e.target.id === 'modalGrafica') {
    cerrarModalGrafica();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('modalGrafica').classList.contains('activo')) {
    cerrarModalGrafica();
  }
});

/* ================= MODAL CONFIGURACIÓN ANKI ================= */
const modalAnki = document.getElementById('modalAnki');
const btnConfigAnki = document.getElementById('btnConfigAnki');
const ankiRadiosModo = document.querySelectorAll('input[name="ankiModoLimite"]');
const ankiCampoPersonalizado = document.getElementById('ankiCampoPersonalizado');
const ankiInputLimiteDiario = document.getElementById('ankiLimiteDiario');
const ankiChkEstricto = document.getElementById('ankiLimiteEstricto');
const ankiInputNuevas = document.getElementById('ankiLimiteNuevas');
const ankiChkSinLimiteNuevas = document.getElementById('ankiNuevasSinLimite');
const ankiSelectOrden = document.getElementById('ankiOrden');
const ankiChkBarajar = document.getElementById('ankiBarajar');
const ankiAyudaModo = document.getElementById('ankiAyudaModo');
const ankiMantMsg = document.getElementById('ankiMantMsg');
const ankiEstadoGuardado = document.getElementById('ankiEstadoGuardado');
const btnAnkiGuardar = document.getElementById('btnAnkiGuardar');
const btnAnkiCancelar = document.getElementById('btnAnkiCancelar');
const btnAnkiSync = document.getElementById('btnAnkiSync');
const btnAnkiReset = document.getElementById('btnAnkiReset');

/** @type {Object<string, string>} Textos de ayuda para los modos de límite Anki. */
const AYUDA_MODO_ANKI = {
  auto: 'Reparte el mazo para llegar al examen con todo repasado.',
  personalizado: 'Fijas tú cuántas tarjetas quieres cada día.',
  ilimitado: 'Hoy entran todas las tarjetas vencidas y todas las nuevas (salvo el tope de nuevas).'
};

/** @type {boolean} Evita solapar o cerrar acciones de mantenimiento en curso. */
let ankiOcupado = false; // evita cerrar/lanzar acciones solapadas mientras se guarda o se mantiene el mazo

/**
 * Lee el modo de límite Anki seleccionado.
 * @returns {string} Modo marcado o `auto` si no hay selección.
 */
function modoAnkiSeleccionado() {
  const sel = document.querySelector('input[name="ankiModoLimite"]:checked');
  return sel ? sel.value : 'auto';
}

/**
 * Sincroniza los campos visibles y habilitados con el modo Anki seleccionado.
 * @returns {void}
 */
function actualizarCamposAnki() {
  const modo = modoAnkiSeleccionado();
  ankiCampoPersonalizado.hidden = modo !== 'personalizado';
  ankiAyudaModo.textContent = AYUDA_MODO_ANKI[modo] || '';
  ankiInputNuevas.disabled = ankiChkSinLimiteNuevas.checked;
}

/**
 * Muestra un mensaje de resultado en el panel de mantenimiento del mazo.
 * @param {string} texto Texto del mensaje.
 * @param {string} [tipo] Clase de estado opcional, por ejemplo `ok` o `error`.
 * @returns {void}
 */
function mostrarMensajeMant(texto, tipo) {
  ankiMantMsg.textContent = texto || '';
  ankiMantMsg.className = 'anki-mant-msg' + (tipo ? ` ${tipo}` : '');
}

/**
 * Carga en el formulario los valores de la configuración Anki guardada.
 * @returns {void}
 */
function rellenarFormularioAnki() {
  const cfg = obtenerConfigAnki();
  ankiRadiosModo.forEach(r => { r.checked = r.value === cfg.modoLimite; });
  ankiInputLimiteDiario.value = cfg.limiteDiario;
  ankiChkEstricto.checked = cfg.limiteEstricto;
  ankiChkSinLimiteNuevas.checked = cfg.limiteNuevas === 0;
  ankiInputNuevas.value = cfg.limiteNuevas > 0 ? cfg.limiteNuevas : 10;
  ankiSelectOrden.value = cfg.orden;
  ankiChkBarajar.checked = cfg.barajarOpciones;
  ankiInputLimiteDiario.classList.remove('invalido');
  ankiInputNuevas.classList.remove('invalido');
  ankiEstadoGuardado.textContent = '';
  mostrarMensajeMant('');
  actualizarCamposAnki();
}

/**
 * Prepara y muestra el modal de configuración Anki.
 * @returns {void}
 */
function abrirModalAnki() {
  rellenarFormularioAnki();
  modalAnki.classList.add('activo');
  setTimeout(() => {
    const marcado = document.querySelector('input[name="ankiModoLimite"]:checked');
    if (marcado) marcado.focus();
  }, 30);
}

/**
 * Cierra el modal de configuración si no hay una operación en curso.
 * @returns {void}
 */
function cerrarModalAnki() {
  if (ankiOcupado) return;
  modalAnki.classList.remove('activo');
}

/**
 * Valida y convierte un valor en un entero positivo dentro del rango admitido.
 * @param {string|number} valor Valor que se desea convertir.
 * @returns {number|null} Entero entre 1 y 999, o `null` si no es válido.
 */
function enteroPositivo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

/**
 * Valida y guarda los cambios del formulario de configuración Anki.
 * Mantiene abierto el modal si la validación o la sincronización no se completan.
 * @returns {Promise<void>}
 */
async function guardarCambiosAnki() {
  if (ankiOcupado) return;
  /** @type {ConfiguracionAnkiFormulario} */
  const previa = obtenerConfigAnki();
  const modo = modoAnkiSeleccionado();
  ankiInputLimiteDiario.classList.remove('invalido');
  ankiInputNuevas.classList.remove('invalido');
  ankiEstadoGuardado.textContent = '';

  let limiteDiario = previa.limiteDiario;
  if (modo === 'personalizado') {
    const n = enteroPositivo(ankiInputLimiteDiario.value);
    if (n === null) {
      ankiInputLimiteDiario.classList.add('invalido');
      ankiEstadoGuardado.textContent = 'Introduce un límite diario entre 1 y 999.';
      ankiInputLimiteDiario.focus();
      return;
    }
    limiteDiario = n;
  } else {
    limiteDiario = enteroPositivo(ankiInputLimiteDiario.value) || previa.limiteDiario;
  }

  let limiteNuevas = 0;
  if (!ankiChkSinLimiteNuevas.checked) {
    const n = enteroPositivo(ankiInputNuevas.value);
    if (n === null) {
      ankiInputNuevas.classList.add('invalido');
      ankiEstadoGuardado.textContent = 'El máximo de nuevas debe estar entre 1 y 999 (o marca «Sin límite»).';
      ankiInputNuevas.focus();
      return;
    }
    limiteNuevas = n;
  }

  /** @type {ConfiguracionAnkiFormulario} */
  const nuevaConfig = {
    modoLimite: modo,
    limiteDiario,
    limiteNuevas,
    orden: ankiSelectOrden.value,
    barajarOpciones: ankiChkBarajar.checked,
    limiteEstricto: ankiChkEstricto.checked
  };

  ankiOcupado = true;
  btnAnkiGuardar.disabled = true;
  btnAnkiGuardar.textContent = 'Guardando…';
  let sincronizado = true;
  try {
    sincronizado = await guardarConfigAnki(nuevaConfig);
  } catch (err) {
    console.error('Error guardando la configuración de Anki:', err);
    sincronizado = false;
  }
  ankiOcupado = false;
  btnAnkiGuardar.disabled = false;
  btnAnkiGuardar.textContent = 'Guardar cambios';

  renderAnki(); // el contador "Repasar X tarjetas hoy" se actualiza al instante

  if (sincronizado === false) {
    ankiEstadoGuardado.textContent = 'Guardado en este dispositivo, pero no se pudo sincronizar con la nube. Pulsa «Guardar cambios» para reintentar.';
    return;
  }
  cerrarModalAnki();
}

/**
 * Busca tests nuevos y añade sus preguntas al mazo Anki.
 * @returns {Promise<void>}
 */
async function buscarNuevosTestsAnki() {
  if (ankiOcupado) return;
  ankiOcupado = true;
  btnAnkiSync.disabled = true;
  btnAnkiReset.disabled = true;
  const textoOriginal = btnAnkiSync.textContent;
  btnAnkiSync.textContent = 'Buscando…';
  mostrarMensajeMant('');
  try {
    const r = await sincronizarNuevosTestsAlMazo();
    if (r.anadidas > 0) {
      const t = r.testsNuevos === 1 ? '1 test nuevo' : `${r.testsNuevos} tests nuevos`;
      mostrarMensajeMant(
        `Se añadieron ${r.anadidas} ${r.anadidas === 1 ? 'tarjeta nueva' : 'tarjetas nuevas'} (${t}). Mazo: ${r.totalMazo} tarjetas.` +
        (r.omitidas > 0 ? ` ${r.omitidas} preguntas omitidas por no tener "correcta".` : '') +
        (r.sincronizado === false ? ' Guardado solo en este dispositivo (sin conexión con la nube).' : ''),
        r.sincronizado === false ? 'error' : 'ok'
      );
    } else {
      mostrarMensajeMant('No hay tests nuevos en data/: el mazo ya está al día (0 tarjetas añadidas).');
    }
    renderAnki();
  } catch (err) {
    console.error('Error buscando nuevos tests:', err);
    mostrarMensajeMant('No se pudo leer data/. Comprueba tu conexión e inténtalo de nuevo.', 'error');
  }
  btnAnkiSync.textContent = textoOriginal;
  btnAnkiSync.disabled = false;
  btnAnkiReset.disabled = false;
  ankiOcupado = false;
}

/**
 * Solicita confirmación y reinicia el progreso de las tarjetas Anki.
 * @returns {Promise<void>}
 */
async function reiniciarAnki() {
  if (ankiOcupado) return;
  if (!confirm('¿Seguro que quieres reiniciar TODO el progreso de Anki?\n\nSe borrará el estado de las tarjetas (fallos, intervalos y madurez) y el mazo volverá a empezar con todas las preguntas como nuevas. Tus resultados de tests y tu configuración no se tocan.')) {
    return;
  }
  ankiOcupado = true;
  btnAnkiSync.disabled = true;
  btnAnkiReset.disabled = true;
  const textoOriginal = btnAnkiReset.textContent;
  btnAnkiReset.textContent = 'Reiniciando…';
  mostrarMensajeMant('');
  try {
    const r = await reiniciarProgresoAnki();
    mostrarMensajeMant(`Progreso reiniciado: mazo recreado con ${r.totalMazo} tarjetas nuevas.`, 'ok');
    renderAnki();
  } catch (err) {
    console.error('Error reiniciando Anki:', err);
    mostrarMensajeMant('No se pudo reiniciar el mazo. Inténtalo de nuevo.', 'error');
    renderAnki();
  }
  btnAnkiReset.textContent = textoOriginal;
  btnAnkiSync.disabled = false;
  btnAnkiReset.disabled = false;
  ankiOcupado = false;
}

btnConfigAnki.addEventListener('click', (e) => {
  e.stopPropagation();
  abrirModalAnki();
});
document.getElementById('btnCerrarModalAnki').addEventListener('click', cerrarModalAnki);
btnAnkiCancelar.addEventListener('click', cerrarModalAnki);
btnAnkiGuardar.addEventListener('click', guardarCambiosAnki);
btnAnkiSync.addEventListener('click', buscarNuevosTestsAnki);
btnAnkiReset.addEventListener('click', reiniciarAnki);
ankiRadiosModo.forEach(r => r.addEventListener('change', actualizarCamposAnki));
ankiChkSinLimiteNuevas.addEventListener('change', () => {
  actualizarCamposAnki();
  if (!ankiChkSinLimiteNuevas.checked) ankiInputNuevas.focus();
});
modalAnki.addEventListener('click', (e) => {
  if (e.target.id === 'modalAnki') cerrarModalAnki();
});
modalAnki.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input[type="number"]')) {
    e.preventDefault();
    guardarCambiosAnki();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalAnki.classList.contains('activo')) {
    cerrarModalAnki();
  }
});

/**
 * Solicita confirmación y borra todos los resultados guardados.
 * @returns {Promise<void>}
 * @throws {Error} Si la operación de borrado rechaza su promesa.
 */
async function confirmarBorrado() {
  if (confirm('¿Seguro que quieres borrar todos tus resultados guardados?')) {
    await borrarProgreso();
    renderDashboard();
  }
}

document.getElementById('btnExportarJSON').addEventListener('click', exportarJSON);
document.querySelectorAll('input[name="modo"]').forEach((radio) => {
  radio.addEventListener('change', actualizarEnlaces);
});
document.getElementById('btnBorrarResultados').addEventListener('click', confirmarBorrado);

document.getElementById('inputJson').addEventListener('change', (e) => {
  if (e.target.files[0]) {
    importarJSON(e.target.files[0], renderDashboard);
  }
});

// Pinta al instante con lo local y luego actualiza desde Supabase
renderDashboard();
sincronizarDesdeNube()
  .then(() => { renderDashboard(); return sincronizarTestsSiToca(); })
  .then((r) => { if (r && r.anadidas > 0) renderDashboard(); });
