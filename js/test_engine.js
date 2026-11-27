(function () {
  const params = new URLSearchParams(window.location.search);
  const modoParam = params.get('modo');
  const MODO = ['estudio', 'repaso', 'falladas'].includes(modoParam) ? modoParam : 'examen';
  const letras = ['a', 'b', 'c', 'd'];
  const BANDERA_VISIBLE = ['repaso', 'falladas'].includes(modoParam);

  let PREGUNTAS = [];
  let BANDERA_TEST_VISIBLE = false;
  window.TEST_ID = null;

  function escaparHTML(valor) {
    return String(valor).replace(/[&<>"]/g, (caracter) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    }[caracter]));
  }

  const lblModo = document.getElementById('lblModo');
  if (lblModo) {
    lblModo.textContent = MODO === 'estudio' ? 'Modo estudio' : MODO === 'falladas' ? 'Preguntas falladas' : MODO === 'repaso' ? 'Repaso' : 'Modo examen';
  }

  const form = document.getElementById('formTest');
  const contenedor = document.getElementById('preguntasContainer');
  const aviso = document.getElementById('avisoTest');
  const tituloNum = document.getElementById('testNum');
  const btnCorregir = document.getElementById('btnCorregir');
  const btnAnadirPregunta = document.getElementById('btnAnadirPregunta');
  const estadoGuardado = document.getElementById('estadoGuardado');

  // Sincroniza con la nube en segundo plano nada más abrir: así el guardado parte del progreso
  // más reciente (evita pisar el historial de otro dispositivo si se abre el test directamente).
  const sincronizacionInicial = (typeof sincronizarDesdeNube === 'function')
    ? sincronizarDesdeNube().catch((e) => { console.error(e); return null; })
    : Promise.resolve(null);

  window.addEventListener('beforeunload', () => {
    sincronizarFlagsSesion({ keepalive: true }).catch((err) => {
      console.error('Error enviando correcciones al cerrar la página:', err);
    });
  });

  /* ================= AVISOS ================= */
  function mostrarAviso(html) {
    form.style.display = 'none';
    aviso.style.cssText = 'display:block;padding:18px 20px;margin:24px 0;border-radius:var(--radius-2xl);' +
      'background:var(--aviso-fondo);border:1px solid var(--aviso-fondo);color:var(--aviso);line-height:1.5;';
    aviso.innerHTML = html + '<p style="margin:12px 0 0;"><a href="index.html">← Volver a la lista de tests</a></p>';
  }

  function mostrarEstadoGuardado(tipo, texto) {
    const colores = {
      guardando: 'var(--texto-secundario)',
      ok: 'var(--primario)',
      aviso: 'var(--aviso)'
    };
    estadoGuardado.style.cssText = `margin-top:12px;font-size:var(--text-base);font-weight:var(--weight-semibold);color:${colores[tipo] || 'var(--texto-secundario)'};`;
    estadoGuardado.textContent = texto;
  }

  /* ================= PARCHES DE PREGUNTAS ================= */
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
        } else if (pregunta && (
          !parche.esNueva
          || String(pregunta.id) === claveTarjeta(testId, parche.preguntaIdx)
        )) {
          aplicarParcheAPregunta(pregunta, parche);
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

  function limpiarVistaPreviaImagen() {
    if (urlVistaPreviaImagen) URL.revokeObjectURL(urlVistaPreviaImagen);
    urlVistaPreviaImagen = null;
    mc.imagenPreview.hidden = true;
    mc.imagenPreviewImg.removeAttribute('src');
    mc.imagenNombre.textContent = '';
  }

  function mostrarVistaPreviaImagen(src, nombre, temporal = false) {
    limpiarVistaPreviaImagen();
    if (!src) return;
    urlVistaPreviaImagen = temporal ? src : null;
    mc.imagenPreviewImg.src = src;
    mc.imagenNombre.textContent = nombre || 'Imagen seleccionada';
    mc.imagenPreview.hidden = false;
  }

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

  function sincronizarRadioC() {
    const vacia = !mc.opciones[2].value.trim();
    mc.radios[2].disabled = vacia;
    if (vacia && mc.radios[2].checked) mc.radios[2].checked = false;
  }

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
  function obtenerIdTest() {
    const raw = (params.get('id') || '').trim();
    if (!/^\d{1,3}$/.test(raw)) return null;
    const n = parseInt(raw, 10);
    return n >= 1 ? n : null;
  }

  // Usa cargarDatosTest (storage.js): prueba data/test_070.json y luego data/test_70.json
  async function cargarJSONTest(n) {
    const data = await cargarDatosTest(n);
    if (!data) throw new Error(`No se pudo cargar data/test_${String(n).padStart(3, '0')}.json`);
    return data;
  }

  function normalizarImagen(ruta) {
    return ruta ? String(ruta).replace(/^\.\.\//, '') : '';
  }

  /* ================= RENDER (modos examen / estudio) ================= */
  function renderPreguntas() {
    contenedor.innerHTML = '';

    PREGUNTAS.forEach((preg, idx) => {
      contenedor.appendChild(crearTarjetaPregunta(preg, idx));
    });
  }

  function crearTarjetaPregunta(preg, idx) {
    const imagenSrc = normalizarImagen(preg.imagen);
    const tieneImg = Boolean(imagenSrc);
    const article = document.createElement('article');
    article.className = `pregunta-item ${tieneImg ? '' : 'sin-imagen'}`;
    article.id = `pregunta-${idx}`;

    const opcionesHTML = preg.opciones.map((textoOp, opIdx) => `
      <label class="opcion-label" id="lbl-${idx}-${opIdx}">
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

  function marcarCorreccionPregunta(idx, seleccion) {
    const correcta = PREGUNTAS[idx].correcta;
    if (typeof correcta !== 'number') return; // JSON sin respuesta correcta conocida
    PREGUNTAS[idx].opciones.forEach((_, opIdx) => {
      const lbl = document.getElementById(`lbl-${idx}-${opIdx}`);
      lbl.classList.remove('es-correcta', 'es-fallo');
      if (opIdx === correcta) {
        lbl.classList.add('es-correcta');
      } else if (seleccion === opIdx && seleccion !== correcta) {
        lbl.classList.add('es-fallo');
      }
    });
  }

  /* ================= CORRECCIÓN + GUARDADO ================= */
  let corrigiendo = false;

  window.corregirTest = async function () {
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
      mostrarEstadoGuardado('aviso',
        'Este test no tiene respuestas correctas en su JSON: no se ha guardado el resultado.');
      if (btnVolver) btnVolver.style.display = 'inline-flex';
      return;
    }

    mostrarEstadoGuardado('guardando', 'Guardando progreso...');

    let guardadoNube = true;
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

    const nFallos = indicesFallados.length;
    const notaRepaso = nFallos
      ? ` · ${nFallos} ${nFallos === 1 ? 'fallo añadido' : 'fallos añadidos'} al repaso Anki`
      : '';

    if (guardadoNube) {
      mostrarEstadoGuardado('ok', '✓ Progreso guardado en la nube' + notaRepaso);
    } else {
      mostrarEstadoGuardado('aviso',
        'No se pudo confirmar el guardado en la nube. El resultado está en este dispositivo; ' +
        'exporta el .json desde la lista si quieres un respaldo.' + notaRepaso);
    }

    if (btnVolver) btnVolver.style.display = 'inline-flex';
  };

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

    const el = (id) => document.getElementById(id);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const reducirMovimiento = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Fisher–Yates (modifica y devuelve el array)
    function barajarArray(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    function calcularMediana(valores) {
      if (!valores.length) return 0;
      const orden = [...valores].sort((a, b) => a - b);
      const mitad = Math.floor(orden.length / 2);
      return orden.length % 2 ? orden[mitad] : (orden[mitad - 1] + orden[mitad]) / 2;
    }

    const fmtSeg = (s) => `${(Math.round(s * 10) / 10).toFixed(1)}s`;

    function fechaCortaISO(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d)
        .toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
        .replace(/\./g, '');
    }

    // Cronómetro silencioso: solo guarda el instante de inicio; no pinta nada en pantalla
    function iniciarCronometro() {
      inicioTarjeta = performance.now();
    }

    // Congela el tiempo exacto al responder (tope 60 s, 1 decimal) en tiempoActual
    function detenerCronometro() {
      if (inicioTarjeta === null) return;
      const seg = Math.min(TOPE_TIEMPO_SEG, (performance.now() - inicioTarjeta) / 1000);
      inicioTarjeta = null;
      tiempoActual = Math.round(seg * 10) / 10;
    }

    // Tiempo esperado para ESTA tarjeta:
    //   con historial (tiempoMedioSeg > 0): 65 % su tiempo medio histórico + 35 % mediana de hoy
    //   sin historial: la mediana de hoy (10 s de referencia neutral mientras haya < 3 respuestas)
    function calcularReferencia(tiemposPrevios, tiempoMedioTarjeta) {
      const real = tiemposPrevios.length >= MIN_RESPUESTAS_MEDIANA;
      const medianaHoy = real ? calcularMediana(tiemposPrevios) : REFERENCIA_INICIAL_SEG;
      const hist = Number(tiempoMedioTarjeta) > 0;
      const esperado = hist ? (0.65 * Number(tiempoMedioTarjeta)) + (0.35 * medianaHoy) : medianaHoy;
      return { real, medianaHoy, hist, esperado };
    }

    // La sugerencia solo destaca un botón: la calificación final la elige siempre el usuario.
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

    function pintarCarga(texto) {
      fase = 'carga';
      cont.innerHTML = `<div class="repaso-carga"><div class="repaso-spinner" aria-hidden="true"></div><p>${esc(texto)}</p></div>`;
    }

    function pintarAviso(html) {
      fase = 'final';
      cont.innerHTML = `<div class="repaso-final"><p class="repaso-final-sub">${html}</p><a class="btn btn--primario btn--lg" href="index.html">Volver al panel</a></div>`;
    }

    function preguntaDeClave(clave) {
      const t = obtenerTarjetas()[clave];
      if (!t) return null;
      const preguntas = preguntasDeDatosTest(cacheTests.get(t.testId));
      const p = preguntas ? preguntas[t.preguntaIdx] : null;
      return p && Array.isArray(p.opciones) && typeof p.correcta === 'number' ? p : null;
    }

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

    function etiquetaIntervalo(nivel, dias) {
      if (nivel === 'again' || !(dias > 0)) return 'Hoy';
      return dias === 1 ? '1 día' : `${dias} días`;
    }

    /* ---------- Barra superior (persistente entre tarjetas) ---------- */
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

    function generarOrdenVisual() {
      const barajar = typeof obtenerConfigAnki === 'function' && obtenerConfigAnki().barajarOpciones === true;
      ordenVisual = pregActual.opciones.map((_, i) => i);
      if (barajar) barajarArray(ordenVisual);
      correctaVisual = ordenVisual.indexOf(pregActual.correcta);
    }

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
        <button type="button" class="repaso-opcion" data-op="${i}">
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

      stage.querySelectorAll('.repaso-opcion').forEach((btn) => {
        btn.addEventListener('click', () => seleccionarOpcion(Number(btn.dataset.op)));
      });
    }

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

    function mostrarResultado(primera) {
      const i = seleccionVisual;
      const correcta = correctaVisual;
      const acierto = aciertoActual;
      const tarjetaAntes = obtenerTarjetas()[claveActual] || {};
      const sug = sugerirConfianza(acierto, tiempoActual, tiemposPrevios, tarjetaAntes.tiempoMedioSeg);
      nivelSugerido = sug.nivel;

      cont.querySelectorAll('.repaso-opcion').forEach((btn, idx) => {
        btn.classList.add('bloqueada');
        btn.disabled = true;
        const icono = btn.querySelector('.repaso-opcion-icono');
        if (idx === correcta) {
          btn.classList.add('es-correcta');
          if (!acierto) btn.classList.add('revelada');
          if (icono) icono.innerHTML = ICONO_CHECK;
        } else if (idx === i) {
          btn.classList.add('es-fallo');
          if (icono) icono.innerHTML = ICONO_ASPA;
        }
      });

      const intervalos = previsualizarIntervalosTarjeta(claveActual) || {};
      const panel = el('repasoConfianza');
      const hoyStr = hoyISO();
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
          <h2>${MODO === 'falladas'
            ? repasadas ? '¡Repaso de falladas completado!' : 'No tienes preguntas falladas'
            : repasadas ? '¡Repaso de hoy completado!' : '¡Estás al día!'}</h2>
          <p class="repaso-final-sub">${repasadas
            ? `Has repasado ${repasadas} ${repasadas === 1 ? 'tarjeta' : 'tarjetas'} (${c.again} ${c.again === 1 ? 'repetición' : 'repeticiones'} por «Again»).`
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
        Promise.all([
          sincronizarFlagsSesion(),
          esperarGuardadoProgreso().then((ok) => {
            if (!ok) console.error('El progreso más reciente sigue guardado solo en este dispositivo.');
          })
        ]).catch((err) => {
          console.error('Error guardando el progreso al salir:', err);
        }).finally(() => {
          window.location.assign(salir.href);
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
    (async function arrancar() {
      pintarCarga('Cargando tu progreso...');
      try {
        await sincronizacionInicial;
        if (necesitaInicializarMazo()) {
          pintarCarga('Preparando mazo Anki...');
          await inicializarMazoAnkiDesdeTests();
        } else {
          pintarCarga('Buscando tests nuevos...');
          await sincronizarTestsSiToca();
        }
      } catch (err) {
        console.error('Error preparando el mazo:', err);
        pintarAviso('No se pudo preparar el mazo Anki. Comprueba tu conexión y que los tests estén en <code>data/</code>.');
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
  (async function iniciar() {
    if (MODO === 'repaso' || MODO === 'falladas') {
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
