(function () {
  const params = new URLSearchParams(window.location.search);
  const MODO = params.get('modo') === 'estudio' ? 'estudio' : 'examen';
  const letras = ['a', 'b', 'c', 'd'];

  let PREGUNTAS = [];
  window.TEST_ID = null;

  const lblModo = document.getElementById('lblModo');
  if (lblModo) lblModo.textContent = MODO === 'estudio' ? 'Modo estudio' : 'Modo examen';

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

  async function cargarJSONTest(n) {
    // Primero 'test_070.json'; si no existe, 'test_70.json' (algunos JSON no llevan cero inicial)
    const candidatos = [...new Set([String(n).padStart(3, '0'), String(n)])];
    let ultimoError = null;
    for (const nombre of candidatos) {
      try {
        const resp = await fetch(`data/test_${nombre}.json`);
        if (!resp.ok) {
          ultimoError = new Error(`HTTP ${resp.status} en data/test_${nombre}.json`);
          continue;
        }
        return await resp.json();
      } catch (err) {
        ultimoError = err;
      }
    }
    throw ultimoError || new Error('No se pudo cargar el test');
  }

  /* ================= RENDER ================= */
  function renderPreguntas() {
    contenedor.innerHTML = '';

    PREGUNTAS.forEach((preg, idx) => {
      const imagenSrc = preg.imagen ? String(preg.imagen).replace(/^\.\.\//, '') : '';
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

    PREGUNTAS.forEach((preg, idx) => {
      const seleccionado = document.querySelector(`input[name="p_${idx}"]:checked`);
      const valor = seleccionado ? Number(seleccionado.value) : -1;
      if (valor === preg.correcta) aciertos++;
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
      const resultado = await guardarResultadoTest(clave, aciertos, fallos, total);
      if (resultado === false) guardadoNube = false;     // storage.js devuelve false si Supabase falló

      const guardado = obtenerProgreso()[clave];
      const info = document.getElementById('infoIntentos');
      if (info && guardado) info.innerHTML = ` | Veces realizado: <strong>${guardado.intentos}</strong>`;
    } catch (err) {
      console.error('Error guardando el resultado:', err);
      guardadoNube = false;
    }

    if (guardadoNube) {
      mostrarEstadoGuardado('ok', '✓ Progreso guardado en la nube');
    } else {
      mostrarEstadoGuardado('aviso',
        'No se pudo confirmar el guardado en la nube. El resultado está en este dispositivo; ' +
        'exporta el .json desde la lista si quieres un respaldo.');
    }

    if (btnVolver) btnVolver.style.display = 'inline-block';
  };

  /* ================= ARRANQUE ================= */
  (async function iniciar() {
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
      PREGUNTAS = Array.isArray(data) ? data : (data.preguntas || []);
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
