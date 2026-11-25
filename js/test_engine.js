(function () {
  const params = new URLSearchParams(window.location.search);
  const modoParam = params.get('modo');
  const MODO = (modoParam === 'estudio' || modoParam === 'repaso') ? modoParam : 'examen';
  const letras = ['a', 'b', 'c', 'd'];

  let PREGUNTAS = [];
  window.TEST_ID = null;

  const lblModo = document.getElementById('lblModo');
  if (lblModo) {
    lblModo.textContent = MODO === 'estudio' ? 'Modo estudio' : MODO === 'repaso' ? 'Repaso' : 'Modo examen';
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
    aviso.style.cssText = 'display:block;padding:18px 20px;margin:24px 0;border-radius:var(--radius-2xl);' +
      'background:var(--color-aviso-fondo);border:1px solid var(--color-aviso-borde);color:var(--color-aviso-texto);line-height:1.5;';
    aviso.innerHTML = html + '<p style="margin:12px 0 0;"><a href="index.html">← Volver a la lista de tests</a></p>';
  }

  function mostrarEstadoGuardado(tipo, texto) {
    const colores = {
      guardando: 'var(--texto-secundario)',
      ok: 'var(--color-primario)',
      aviso: 'var(--color-aviso-oscuro)'
    };
    estadoGuardado.style.cssText = `margin-top:12px;font-size:var(--text-base);font-weight:var(--weight-semibold);color:${colores[tipo] || 'var(--texto-secundario)'};`;
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
      if (btnVolver) btnVolver.style.display = 'inline-flex';
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
  const MS_SALIDA = 144;       // duración de la animación de salida de la tarjeta (debe coincidir con .repaso-stage.saliendo en test.css)

  const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const ICONO_CHECK = `<svg ${SVG_ATTRS}><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
  const ICONO_ASPA = `<svg ${SVG_ATTRS}><path d="M6 6l12 12M18 6L6 18"/></svg>`;

  function iniciarRepaso() {
    const cont = document.getElementById('repasoContainer');
    if (!cont) return;

    document.documentElement.classList.add('modo-repaso');
    form.style.display = 'none';
    cont.style.display = 'flex';
    document.title = 'Repaso · dgt-eando';

    const cacheTests = new Map();          // testId -> JSON del test
    let sesion = null;                     // { pendientes, total, hechas, contadores, racha, rachaMax, repetidas }
    let fase = 'carga';                    // carga | pregunta | confianza | guardando | final
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
      cont.innerHTML = `<div class="repaso-final"><p class="repaso-final-sub">${html}</p><a class="repaso-btn-volver" href="index.html">Volver al panel</a></div>`;
    }

    function preguntaDeClave(clave) {
      const t = obtenerTarjetas()[clave];
      if (!t) return null;
      const preguntas = preguntasDeDatosTest(cacheTests.get(t.testId));
      const p = preguntas ? preguntas[t.preguntaIdx] : null;
      return p && Array.isArray(p.opciones) && typeof p.correcta === 'number' ? p : null;
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
            <a href="index.html" class="repaso-cerrar" aria-label="Salir del repaso" title="Salir">✕</a>
            <div class="repaso-progreso-wrap">
              <div class="repaso-progreso" id="repasoProgreso" role="progressbar" aria-label="Progreso del repaso" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <div class="repaso-progreso-barra" id="repasoBarra"></div>
              </div>
              <div class="repaso-contador" id="repasoContador">0 / 0</div>
            </div>
            <div class="repaso-combo" id="repasoCombo" title="Racha de aciertos seguidos" aria-live="polite">
              <span class="repaso-combo-fuego" aria-hidden="true">🔥</span>
              <span id="repasoComboNum">0</span>
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

      if (!el('repasoStage')) montarShell();
      const stage = el('repasoStage');
      stage.classList.remove('saliendo');
      actualizarProgreso();
      pintarCombo(null);

      const imagenSrc = normalizarImagen(pregActual.imagen);
      const repeticion = sesion.repetidas.has(claveActual) ? '<span class="repaso-repeticion">Repetición</span>' : '';
      const refTest = String(tarjeta.testId).padStart(3, '0');
      const refPregunta = String((Number(tarjeta.preguntaIdx) || 0) + 1).padStart(2, '0');

      // Orden visual: posición en pantalla -> índice original en el JSON.
      // Si "barajarOpciones" está activo se mezcla en cada aparición; el rastreo de la correcta se mantiene
      // en correctaVisual, y las teclas 1-2-3 y las letras a-b-c siguen el orden visual de arriba abajo.
      const barajar = typeof obtenerConfigAnki === 'function' && obtenerConfigAnki().barajarOpciones === true;
      const ordenVisual = pregActual.opciones.map((_, i) => i);
      if (barajar) barajarArray(ordenVisual);
      correctaVisual = ordenVisual.indexOf(pregActual.correcta);

      const opcionesHTML = ordenVisual.map((idxOriginal, i) => `
        <button type="button" class="repaso-opcion" data-op="${i}">
          <span class="repaso-tecla" aria-hidden="true">${i + 1}</span>
          <span class="repaso-opcion-texto"><span class="opcion-letra">${letras[i]})</span> ${pregActual.opciones[idxOriginal]}</span>
          <span class="repaso-opcion-icono" aria-hidden="true"></span>
        </button>
      `).join('');

      stage.innerHTML = `
        <article class="repaso-tarjeta ${imagenSrc ? 'con-imagen' : ''}" id="repasoTarjeta">
          <div class="repaso-contexto">
            <span>Test ${esc(refTest)} · Pregunta ${esc(refPregunta)}</span>
            <span class="repaso-contexto-der">
              ${repeticion}
              <span class="repaso-badge madurez-${esc(tarjeta.madurez)}">${ETIQUETA_MADUREZ[tarjeta.madurez] || esc(tarjeta.madurez)}</span>
            </span>
          </div>
          <div class="repaso-cuerpo">
            <h2 class="repaso-enunciado">${pregActual.texto}</h2>
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

      window.scrollTo(0, 0);
      iniciarCronometro();
    }

    /* ---------- Fase 1: elegir respuesta ---------- */
    function seleccionarOpcion(i) {
      if (fase !== 'pregunta' || i < 0 || i >= numOpciones) return;
      fase = 'confianza';
      detenerCronometro();               // congela el tiempo exacto al instante
      bloqueoHasta = Date.now() + 200;   // evita que una doble pulsación salte la fase de confianza

      const correcta = correctaVisual;   // índice visual de la correcta (ya contempla el barajado)
      const acierto = i === correcta;

      cont.querySelectorAll('.repaso-opcion').forEach((btn, idx) => {
        btn.classList.add('bloqueada');
        btn.disabled = true;
        const icono = btn.querySelector('.repaso-opcion-icono');
        if (idx === correcta) {
          btn.classList.add('es-correcta');
          if (!acierto) btn.classList.add('revelada');   // se ilumina un instante después del fallo
          if (icono) icono.innerHTML = ICONO_CHECK;
        } else if (idx === i) {
          btn.classList.add('es-fallo');
          if (icono) icono.innerHTML = ICONO_ASPA;
        }
      });

      // Combo de sesión: sube con cada acierto consecutivo y se reinicia al fallar
      if (acierto) {
        sesion.racha++;
        sesion.rachaMax = Math.max(sesion.rachaMax, sesion.racha);
        pintarCombo('pop');
      } else {
        const habiaRacha = sesion.racha > 0;
        sesion.racha = 0;
        pintarCombo(habiaRacha ? 'cae' : null);
      }

      // Sugerencia de confianza según tiempo esperado (65 % histórico de la tarjeta + 35 % mediana de hoy)
      const tarjetaAntes = obtenerTarjetas()[claveActual] || {};
      aciertoActual = acierto;
      const sug = sugerirConfianza(acierto, tiempoActual, tiemposSesion, tarjetaAntes.tiempoMedioSeg);
      nivelSugerido = sug.nivel;
      tiemposSesion.push(tiempoActual);  // entra en la mediana a partir de la SIGUIENTE pregunta

      // Mejora vs. el anterior repaso: solo la 1.ª vez que sale la tarjeta en la sesión y si hay tiempo previo
      if (!sesion.vistas.has(claveActual)) {
        sesion.vistas.add(claveActual);
        if (Number(tarjetaAntes.ultimoTiempoSeg) > 0) {
          sesion.comparables.add(claveActual);
          if (acierto && tiempoActual < Number(tarjetaAntes.ultimoTiempoSeg)) sesion.mejoradas.add(claveActual);
        }
      }

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
          <span class="repaso-resultado ${acierto ? 'ok' : 'ko'}">${acierto ? '¡Correcto!' : 'Incorrecta'}</span>
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
      requestAnimationFrame(() => {
        panel.scrollIntoView({ behavior: reducirMovimiento() ? 'auto' : 'smooth', block: 'nearest' });
      });
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

      mostrarTarjeta();
      if (typeof ultimaSincronizacionOk !== 'undefined' && ultimaSincronizacionOk === false) {
        const av = el('repasoAvisoNube');
        if (av) av.hidden = false;
      }
    }

    /* ---------- Pantalla final ---------- */
    function mostrarFinal() {
      fase = 'final';
      const e = obtenerColaRepasoHoy();
      const c = sesion ? sesion.contadores : { hard: 0, medium: 0, easy: 0, again: 0 };
      const repasadas = sesion ? sesion.hechas : 0;
      const rachaMax = sesion ? sesion.rachaMax : 0;
      const hayMas = e.colaHoy.length > 0;

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
          <h2>${repasadas ? '¡Repaso de hoy completado!' : '¡Estás al día!'}</h2>
          <p class="repaso-final-sub">${repasadas
            ? `Has repasado ${repasadas} ${repasadas === 1 ? 'tarjeta' : 'tarjetas'} (${c.again} ${c.again === 1 ? 'repetición' : 'repeticiones'} por «Again»).`
            : 'No tienes tarjetas pendientes para hoy.'}</p>
          ${rachaMax > 0 ? `<div class="repaso-racha-final">🔥 Mejor racha: ${rachaMax}</div>` : ''}
          <div class="repaso-resumen">
            <div class="repaso-resumen-item madurez-nueva"><strong>${e.nuevas}</strong><span>Nuevas</span></div>
            <div class="repaso-resumen-item madurez-aprendiendo"><strong>${e.aprendiendo}</strong><span>Aprendiendo</span></div>
            <div class="repaso-resumen-item madurez-joven"><strong>${e.jovenes}</strong><span>Jóvenes</span></div>
            <div class="repaso-resumen-item madurez-madura"><strong>${e.maduras}</strong><span>Maduras</span></div>
          </div>
          ${bloqueTiempos}
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
        else if ((e.key === ' ' || e.key === 'Enter') && nivelSugerido) { e.preventDefault(); calificar(nivelSugerido); }
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
        pendientes: [], total: 0, hechas: 0,
        contadores: { hard: 0, medium: 0, easy: 0, again: 0 },
        repetidas: new Set(),
        racha: 0, rachaMax: 0,
        vistas: new Set(), comparables: new Set(), mejoradas: new Set()
      };
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
