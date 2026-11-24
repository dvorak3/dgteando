(function () {
  const params = new URLSearchParams(window.location.search);
  const modoParam = params.get('modo');
  const MODO = (modoParam === 'estudio' || modoParam === 'repaso') ? modoParam : 'examen';
  const letras = ['a', 'b', 'c', 'd'];

  let PREGUNTAS = [];
  window.TEST_ID = null;

  const lblModo = document.getElementById('lblModo');
  if (lblModo) {
    lblModo.textContent = MODO === 'estudio' ? 'Modo estudio' : MODO === 'repaso' ? 'Repaso Anki' : 'Modo examen';
  }

  const form = document.getElementById('formTest');
  const contenedor = document.getElementById('preguntasContainer');
  const aviso = document.getElementById('avisoTest');
  const tituloNum = document.getElementById('testNum');
  const btnCorregir = document.getElementById('btnCorregir');
  const estadoGuardado = document.getElementById('estadoGuardado');

  // Sincroniza con la nube en segundo plano nada más abrir: así el guardado parte del progreso
  // más reciente (evita pisar el historial de otro dispositivo si se abre el test directamente).
  const sincronizacionInicial = (typeof sincronizarDesdeNube === 'function')
    ? sincronizarDesdeNube().catch((e) => { console.error(e); return null; })
    : Promise.resolve(null);

  /* ================= AVISOS ================= */
  function mostrarAviso(html) {
    form.style.display = 'none';
    aviso.style.cssText = 'display:block;padding:18px 20px;margin:24px 0;border-radius:8px;' +
      'background:#fff4e5;border:1px solid #f0b86e;color:#5f3b00;line-height:1.5;';
    aviso.innerHTML = html + '<p style="margin:12px 0 0;"><a href="index.html">← Volver a la lista de tests</a></p>';
  }

  function mostrarEstadoGuardado(tipo, texto) {
    const colores = {
      guardando: '#6b7280',
      ok: '#2e7d32',
      aviso: '#b45309'
    };
    estadoGuardado.style.cssText = `margin-top:12px;font-size:14px;font-weight:600;color:${colores[tipo] || '#6b7280'};`;
    estadoGuardado.textContent = texto;
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
      const imagenSrc = normalizarImagen(preg.imagen);
      const tieneImg = Boolean(imagenSrc);
      const article = document.createElement('article');
      article.className = `pregunta-item ${tieneImg ? '' : 'sin-imagen'}`;
      article.id = `pregunta-${idx}`;

      const opcionesHTML = preg.opciones.map((textoOp, opIdx) => `
        <label class="opcion-label" id="lbl-${idx}-${opIdx}">
          <input type="radio" name="p_${idx}" value="${opIdx}">
          <span><span class="opcion-letra">${letras[opIdx]})</span> ${textoOp}</span>
        </label>
      `).join('');

      const imagenHTML = tieneImg
        ? `<div class="pregunta-media"><img src="${imagenSrc}" alt="Imagen pregunta ${idx + 1}"></div>`
        : '';

      article.innerHTML = `
        <div class="pregunta-cuerpo">
          <div class="pregunta-enunciado">
            <span class="p-num">${idx + 1}.</span> ${preg.texto}
          </div>
          <div class="opciones-lista">
            ${opcionesHTML}
          </div>
        </div>
        ${imagenHTML}
      `;

      contenedor.appendChild(article);

      // En modo estudio corrige inmediatamente al pulsar una opción
      if (MODO === 'estudio') {
        article.querySelectorAll('input[type="radio"]').forEach(radio => {
          radio.addEventListener('change', (e) => {
            marcarCorreccionPregunta(idx, Number(e.target.value));
          });
        });
      }
    });
  }

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
      if (btnVolver) btnVolver.style.display = 'inline-block';
      return;
    }

    mostrarEstadoGuardado('guardando', 'Guardando progreso...');

    let guardadoNube = true;
    try {
      await sincronizacionInicial;                       // parte del progreso más reciente de la nube
      const clave = `test_${String(window.TEST_ID).padStart(3, '0')}`;  // misma clave que usa index.js
      const resultado = await guardarResultadoTest(clave, aciertos, fallos, total, indicesFallados);
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

    if (btnVolver) btnVolver.style.display = 'inline-block';
  };

  /* =====================================================================
   *  MODO REPASO (Anki): una tarjeta cada vez, controlado por teclado
   * ===================================================================== */
  const TECLA_A_NIVEL = { '1': 'hard', '2': 'medium', '3': 'easy', '4': 'again' };
  const NIVELES = [
    { nivel: 'hard', tecla: '1', etiqueta: 'Hard' },
    { nivel: 'medium', tecla: '2', etiqueta: 'Medium' },
    { nivel: 'easy', tecla: '3', etiqueta: 'Easy' },
    { nivel: 'again', tecla: '4', etiqueta: 'Again' }
  ];
  const ETIQUETA_MADUREZ = { nueva: 'Nueva', aprendiendo: 'Aprendiendo', joven: 'Joven', madura: 'Madura' };
  const PUESTOS_REENCOLAR = 4; // "again": la tarjeta vuelve a salir unos puestos más adelante

  function iniciarRepaso() {
    const cont = document.getElementById('repasoContainer');
    if (!cont) return;

    form.style.display = 'none';
    cont.style.display = 'block';
    document.title = 'Repaso inteligente (Anki)';
    const h1 = document.querySelector('.test-title');
    if (h1) h1.innerHTML = 'repaso <span class="num">Anki</span>';

    const cacheTests = new Map();          // testId -> JSON del test
    let sesion = null;                     // { pendientes, total, hechas, contadores }
    let fase = 'carga';                    // carga | pregunta | confianza | guardando | final
    let claveActual = null;
    let pregActual = null;
    let numOpciones = 0;
    let bloqueoHasta = 0;
    let correctaVisual = -1;               // posición (0-based) de la correcta tal y como se ve en pantalla

    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    // Fisher–Yates (modifica y devuelve el array)
    function barajarArray(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    function pintarCarga(texto) {
      fase = 'carga';
      cont.innerHTML = `<div class="repaso-carga"><div class="repaso-spinner" aria-hidden="true"></div><p>${esc(texto)}</p></div>`;
    }

    function pintarAviso(html) {
      fase = 'final';
      cont.innerHTML = `<div class="repaso-final"><p>${html}</p><a class="repaso-btn-volver" href="index.html">Volver al panel</a></div>`;
    }

    function preguntaDeClave(clave) {
      const t = obtenerTarjetas()[clave];
      if (!t) return null;
      const preguntas = preguntasDeDatosTest(cacheTests.get(t.testId));
      const p = preguntas ? preguntas[t.preguntaIdx] : null;
      return p && Array.isArray(p.opciones) && typeof p.correcta === 'number' ? p : null;
    }

    function etiquetaIntervalo(nivel, dias) {
      if (nivel === 'again' || dias <= 0) return 'Hoy';
      return dias === 1 ? '1 día' : `${dias} días`;
    }

    /* ---------- Pantalla de tarjeta ---------- */
    function mostrarTarjeta() {
      if (!sesion.pendientes.length) { mostrarFinal(); return; }

      claveActual = sesion.pendientes[0];
      pregActual = preguntaDeClave(claveActual);
      if (!pregActual) {               // la pregunta ya no existe en el JSON: se salta
        sesion.pendientes.shift();
        sesion.total = Math.max(sesion.hechas, sesion.total - 1);
        mostrarTarjeta();
        return;
      }

      const tarjeta = obtenerTarjetas()[claveActual];
      numOpciones = pregActual.opciones.length;
      fase = 'pregunta';

      const imagenSrc = normalizarImagen(pregActual.imagen);
      const porcentaje = sesion.total ? Math.round((sesion.hechas / sesion.total) * 100) : 0;
      const repeticion = sesion.repetidas.has(claveActual) ? '<span class="repaso-repeticion">repetición</span>' : '';

      // Orden visual: posición en pantalla -> índice original en el JSON.
      // Si "barajarOpciones" está activo se mezcla en cada aparición; el rastreo de la correcta se mantiene
      // en correctaVisual, y las teclas 1-2-3 y las letras a-b-c siguen el orden visual de arriba abajo.
      const barajar = typeof obtenerConfigAnki === 'function' && obtenerConfigAnki().barajarOpciones === true;
      const ordenVisual = pregActual.opciones.map((_, i) => i);
      if (barajar) barajarArray(ordenVisual);
      correctaVisual = ordenVisual.indexOf(pregActual.correcta);

      const opcionesHTML = ordenVisual.map((idxOriginal, i) => `
        <button type="button" class="repaso-opcion" data-op="${i}">
          <span class="repaso-tecla">${i + 1}</span>
          <span class="repaso-opcion-texto"><span class="opcion-letra">${letras[i]})</span> ${pregActual.opciones[idxOriginal]}</span>
        </button>
      `).join('');

      cont.innerHTML = `
        <div class="repaso-top">
          <a href="index.html" class="repaso-salir">← Salir</a>
          <span class="repaso-contador">Tarjeta ${Math.min(sesion.hechas + 1, sesion.total)} de ${sesion.total} ${repeticion}</span>
          <span class="repaso-badge madurez-${esc(tarjeta.madurez)}">${ETIQUETA_MADUREZ[tarjeta.madurez] || esc(tarjeta.madurez)}</span>
        </div>
        <div class="repaso-progreso" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${porcentaje}">
          <div class="repaso-progreso-barra" style="width:${porcentaje}%"></div>
        </div>
        <article class="repaso-tarjeta ${imagenSrc ? 'con-imagen' : ''}">
          <div class="repaso-cuerpo">
            <div class="repaso-enunciado">${pregActual.texto}</div>
            <div class="repaso-opciones">${opcionesHTML}</div>
          </div>
          ${imagenSrc ? `<div class="repaso-media"><img src="${esc(imagenSrc)}" alt="Imagen de la pregunta"></div>` : ''}
        </article>
        <div class="repaso-confianza" id="repasoConfianza" hidden></div>
        <p class="repaso-ayuda" id="repasoAyuda">Pulsa <kbd>1</kbd> <kbd>2</kbd>${numOpciones > 2 ? ' <kbd>3</kbd>' : ''} para responder</p>
        <p class="repaso-aviso-nube" id="repasoAvisoNube" hidden>⚠ No se pudo sincronizar con la nube; el avance está guardado en este dispositivo.</p>
      `;

      cont.querySelectorAll('.repaso-opcion').forEach((btn) => {
        btn.addEventListener('click', () => seleccionarOpcion(Number(btn.dataset.op)));
      });
    }

    /* ---------- Fase 1: elegir respuesta ---------- */
    function seleccionarOpcion(i) {
      if (fase !== 'pregunta' || i < 0 || i >= numOpciones) return;
      fase = 'confianza';
      bloqueoHasta = Date.now() + 200;   // evita que una doble pulsación salte la fase de confianza

      const correcta = correctaVisual;   // índice visual de la correcta (ya contempla el barajado)
      cont.querySelectorAll('.repaso-opcion').forEach((btn, idx) => {
        btn.classList.add('bloqueada');
        btn.disabled = true;
        if (idx === correcta) btn.classList.add('es-correcta');
        else if (idx === i) btn.classList.add('es-fallo');
      });

      const intervalos = previsualizarIntervalosTarjeta(claveActual) || {};
      const panel = document.getElementById('repasoConfianza');
      const sugerido = i !== correcta ? 'again' : '';
      panel.innerHTML = `
        <p class="repaso-confianza-titulo">${i === correcta ? '¡Correcto!' : 'Incorrecta.'} ¿Cuánta confianza tenías?</p>
        <div class="repaso-confianza-botones">
          ${NIVELES.map((n) => `
            <button type="button" class="repaso-btn-confianza btn-${n.nivel} ${sugerido === n.nivel ? 'sugerido' : ''}" data-nivel="${n.nivel}">
              <span class="repaso-btn-linea"><span class="repaso-tecla">${n.tecla}</span> ${n.etiqueta}</span>
              <span class="repaso-btn-dias">${etiquetaIntervalo(n.nivel, intervalos[n.nivel])}</span>
            </button>
          `).join('')}
        </div>
      `;
      panel.hidden = false;
      panel.querySelectorAll('.repaso-btn-confianza').forEach((btn) => {
        btn.addEventListener('click', () => calificar(btn.dataset.nivel));
      });

      const ayuda = document.getElementById('repasoAyuda');
      if (ayuda) ayuda.innerHTML = 'Pulsa <kbd>1</kbd> Hard · <kbd>2</kbd> Medium · <kbd>3</kbd> Easy · <kbd>4</kbd> Again';
    }

    /* ---------- Fase 2: confianza ---------- */
    async function calificar(nivel) {
      if (fase !== 'confianza' || Date.now() < bloqueoHasta) return;
      fase = 'guardando';
      cont.querySelectorAll('.repaso-btn-confianza').forEach((b) => { b.disabled = true; });

      try {
        await calificarTarjetaAnki(claveActual, nivel);
      } catch (err) {
        console.error('Error calificando la tarjeta:', err);
      }

      sesion.contadores[nivel]++;
      sesion.pendientes.shift();
      if (nivel === 'again') {
        // vuelve a salir unos puestos más adelante en esta misma sesión
        sesion.pendientes.splice(Math.min(sesion.pendientes.length, PUESTOS_REENCOLAR), 0, claveActual);
        sesion.repetidas.add(claveActual);
      } else {
        sesion.hechas++;
      }

      mostrarTarjeta();
      if (typeof ultimaSincronizacionOk !== 'undefined' && ultimaSincronizacionOk === false) {
        const av = document.getElementById('repasoAvisoNube');
        if (av) av.hidden = false;
      }
    }

    /* ---------- Pantalla final ---------- */
    function mostrarFinal() {
      fase = 'final';
      const e = obtenerColaRepasoHoy();
      const c = sesion ? sesion.contadores : { hard: 0, medium: 0, easy: 0, again: 0 };
      const repasadas = sesion ? sesion.hechas : 0;
      const hayMas = e.colaHoy.length > 0;

      cont.innerHTML = `
        <div class="repaso-final">
          <div class="repaso-final-icono" aria-hidden="true">✓</div>
          <h2>${repasadas ? '¡Repaso de hoy completado!' : '¡Estás al día!'}</h2>
          <p class="repaso-final-sub">${repasadas
            ? `Has repasado ${repasadas} ${repasadas === 1 ? 'tarjeta' : 'tarjetas'} (${c.again} ${c.again === 1 ? 'repetición' : 'repeticiones'} por «Again»).`
            : 'No tienes tarjetas pendientes para hoy.'}</p>
          <div class="repaso-resumen">
            <div class="repaso-resumen-item madurez-nueva"><strong>${e.nuevas}</strong><span>Nuevas</span></div>
            <div class="repaso-resumen-item madurez-aprendiendo"><strong>${e.aprendiendo}</strong><span>Aprendiendo</span></div>
            <div class="repaso-resumen-item madurez-joven"><strong>${e.jovenes}</strong><span>Jóvenes</span></div>
            <div class="repaso-resumen-item madurez-madura"><strong>${e.maduras}</strong><span>Maduras</span></div>
          </div>
          <p class="repaso-final-sub">${e.totalMazo} preguntas en seguimiento · examen en ${e.diasRestantes} ${e.diasRestantes === 1 ? 'día' : 'días'}</p>
          ${hayMas ? `<a class="repaso-btn-secundario" href="test.html?modo=repaso">Seguir con ${e.colaHoy.length} ${e.colaHoy.length === 1 ? 'tarjeta más' : 'tarjetas más'}</a>` : ''}
          <a class="repaso-btn-volver" href="index.html">Volver al panel <kbd>Enter</kbd></a>
        </div>
      `;
    }

    /* ---------- Teclado ---------- */
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;

      if (fase === 'pregunta') {
        const i = ['1', '2', '3'].indexOf(e.key);
        if (i >= 0 && i < numOpciones) { e.preventDefault(); seleccionarOpcion(i); }
      } else if (fase === 'confianza') {
        const nivel = TECLA_A_NIVEL[e.key];
        if (nivel) { e.preventDefault(); calificar(nivel); }
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

      sesion = { pendientes: [], total: 0, hechas: 0, contadores: { hard: 0, medium: 0, easy: 0, again: 0 }, repetidas: new Set() };
      if (!estado.colaHoy.length) { mostrarFinal(); return; }

      pintarCarga(`Cargando ${estado.colaHoy.length} tarjetas...`);
      const ids = [...new Set(estado.colaHoy.map((t) => t.testId))];
      await Promise.all(ids.map(async (id) => { cacheTests.set(id, await cargarDatosTest(id)); }));

      sesion.pendientes = estado.colaHoy.map((t) => t.clave).filter((k) => preguntaDeClave(k));
      sesion.total = sesion.pendientes.length;
      mostrarTarjeta();
    })();
  }

  /* ================= ARRANQUE ================= */
  (async function iniciar() {
    if (MODO === 'repaso') {
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
      PREGUNTAS = preguntasDeDatosTest(data) || [];
      if (!PREGUNTAS.length) throw new Error('El JSON no contiene preguntas');
      renderPreguntas();
    } catch (err) {
      console.error('Error cargando el test:', err);
      mostrarAviso(`<strong>No se pudo cargar el test nº ${n}.</strong><br>` +
        'Comprueba que existe el archivo <code>data/test_' + String(n).padStart(3, '0') + '.json</code> ' +
        '(o <code>data/test_' + n + '.json</code>).');
    }
  })();
})();
