const TOTAL_TESTS = 90;
let chartInstancia = null;

function formatearVeces(n) {
  if (!n || n <= 0) return '-';
  return n === 1 ? '1 vez' : `${n} veces`;
}

function obtenerModoSeleccionado() {
  const sel = document.querySelector('input[name="modo"]:checked');
  return sel ? sel.value : 'examen';
}

/* ================= RENDER DE WIDGETS LATERALES ================= */
function formatearFechaEspanol(fechaISO) {
  const partes = fechaISO.split('-');
  if (partes.length !== 3) return fechaISO;
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const anio = partes[0];
  const mesIdx = parseInt(partes[1], 10) - 1;
  const dia = parseInt(partes[2], 10);
  return `${dia} ${meses[mesIdx] || partes[1]} ${anio}`;
}

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

  const contenedorMain = document.getElementById('examenMainTexto');
  const subFecha = document.getElementById('examenFechaFormateada');

  if (diffDias > 0) {
    const etiqueta = diffDias === 1 ? 'día restante' : 'días restantes';
    contenedorMain.innerHTML = `
      <span class="examen-dias-num">${diffDias}</span>
      <span class="examen-dias-texto">${etiqueta}</span>
    `;
  } else if (diffDias === 0) {
    contenedorMain.innerHTML = `<span class="examen-estado-especial">¡Hoy es el examen!</span>`;
  } else {
    contenedorMain.innerHTML = `<span class="examen-estado-especial" style="color:#6b706c;">Examen finalizado</span>`;
  }

  subFecha.textContent = formatearFechaEspanol(fechaISO);
}

function renderRachaEstudio() {
  const { dias, practicoHoy } = calcularRachaEstudio();
  const rachaTexto = document.getElementById('rachaDiasTexto');
  const rachaMensaje = document.getElementById('rachaMensaje');
  const rachaBadge = document.getElementById('rachaBadge');

  rachaTexto.textContent = dias === 1 ? '1 día' : `${dias} días`;

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
function renderAnki() {
  if (typeof obtenerColaRepasoHoy !== 'function') return;

  const estado = obtenerColaRepasoHoy();
  const num = document.getElementById('ankiCuotaNum');
  const etiqueta = document.getElementById('ankiCuotaEtiqueta');
  const total = document.getElementById('ankiTotalSeguimiento');
  const desglose = document.getElementById('ankiDesglose');
  const btn = document.getElementById('btnRepasoAnki');
  const badge = document.getElementById('ankiBadgeAlDia');
  if (!num || !btn || !badge) return;

  const n = estado.cuotaDiaria;
  num.textContent = n;
  etiqueta.textContent = n === 1 ? 'tarjeta para hoy' : 'tarjetas para hoy';
  total.textContent = estado.totalMazo === 1
    ? '1 pregunta en seguimiento'
    : `${estado.totalMazo} preguntas en seguimiento`;
  desglose.textContent = estado.totalMazo
    ? `${estado.nuevas} nuevas · ${estado.aprendiendo} aprendiendo · ${estado.jovenes} jóvenes · ${estado.maduras} maduras`
    : '';

  btn.href = 'test.html?modo=repaso';

  if (estado.totalMazo === 0 || necesitaInicializarMazo()) {
    // Mazo sin crear: el primer repaso carga los tests de data/ y lo inicializa
    btn.textContent = 'Iniciar mazo Anki (cargar tests)';
    btn.style.display = '';
    badge.style.display = 'none';
  } else if (n > 0) {
    btn.textContent = `Repasar ${n} ${n === 1 ? 'tarjeta' : 'tarjetas'} hoy`;
    btn.style.display = '';
    badge.style.display = 'none';
  } else {
    btn.style.display = 'none';
    badge.textContent = '¡Al día! 0 tarjetas pendientes';
    badge.style.display = 'inline-block';
  }
}

function renderDashboard() {
  renderTabla();
  renderContadorExamen();
  renderRachaEstudio();
  renderAnki();
}

/* ================= INTERACCIÓN EDITOR FECHA EXAMEN ================= */
const cardExamen = document.getElementById('cardExamenDGT');
const editorInline = document.getElementById('examenEditorInline');
const btnEditarFecha = document.getElementById('btnEditarFecha');
const btnGuardarFecha = document.getElementById('btnGuardarFecha');
const inputFechaExamen = document.getElementById('inputFechaExamen');

function toggleEditorFecha(forzarEstado) {
  const abrir = typeof forzarEstado === 'boolean'
    ? forzarEstado
    : !editorInline.classList.contains('abierto');

  if (abrir) {
    inputFechaExamen.value = obtenerFechaExamen();
    editorInline.classList.add('abierto');
    btnEditarFecha.textContent = 'Cerrar';
    setTimeout(() => inputFechaExamen.focus(), 30);
  } else {
    editorInline.classList.remove('abierto');
    btnEditarFecha.textContent = 'Editar';
  }
}

cardExamen.addEventListener('click', (e) => {
  if (e.target.closest('#examenEditorInline') || e.target.closest('#btnEditarFecha')) return;
  toggleEditorFecha();
});

btnEditarFecha.addEventListener('click', (e) => {
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

function actualizarEnlaces() {
  const modo = obtenerModoSeleccionado();
  document.querySelectorAll('.fila-test').forEach(a => {
    a.href = `test.html?id=${a.dataset.num}&modo=${modo}`;
  });
}

/* ================= MODAL Y CHART.JS ================= */
const lineaLimitePlugin = {
  id: 'lineaLimiteAprobado',
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

function abrirGraficaTest(numStr) {
  const clave = `test_${numStr}`;
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
            title(context) {
              return context[0].label;
            },
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

const AYUDA_MODO_ANKI = {
  auto: 'Reparte el mazo para llegar al examen con todo repasado.',
  personalizado: 'Fijas tú cuántas tarjetas quieres cada día.',
  ilimitado: 'Hoy entran todas las tarjetas vencidas y todas las nuevas (salvo el tope de nuevas).'
};

let ankiOcupado = false; // evita cerrar/lanzar acciones solapadas mientras se guarda o se mantiene el mazo

function modoAnkiSeleccionado() {
  const sel = document.querySelector('input[name="ankiModoLimite"]:checked');
  return sel ? sel.value : 'auto';
}

function actualizarCamposAnki() {
  const modo = modoAnkiSeleccionado();
  ankiCampoPersonalizado.hidden = modo !== 'personalizado';
  ankiAyudaModo.textContent = AYUDA_MODO_ANKI[modo] || '';
  ankiInputNuevas.disabled = ankiChkSinLimiteNuevas.checked;
}

function mostrarMensajeMant(texto, tipo) {
  ankiMantMsg.textContent = texto || '';
  ankiMantMsg.className = 'anki-mant-msg' + (tipo ? ` ${tipo}` : '');
}

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

function abrirModalAnki() {
  rellenarFormularioAnki();
  modalAnki.classList.add('activo');
  setTimeout(() => {
    const marcado = document.querySelector('input[name="ankiModoLimite"]:checked');
    if (marcado) marcado.focus();
  }, 30);
}

function cerrarModalAnki() {
  if (ankiOcupado) return;
  modalAnki.classList.remove('activo');
}

function enteroPositivo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

async function guardarCambiosAnki() {
  if (ankiOcupado) return;
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

async function confirmarBorrado() {
  if (confirm('¿Seguro que quieres borrar todos tus resultados guardados?')) {
    await borrarProgreso();
    renderDashboard();
  }
}

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
