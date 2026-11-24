(function () {
  const params = new URLSearchParams(window.location.search);
  const MODO = params.get('modo') || 'examen';
  const letras = ['a', 'b', 'c', 'd'];

  const lblModo = document.getElementById('lblModo');
  if (lblModo) {
    lblModo.textContent = MODO === 'estudio' ? 'Modo estudio' : 'Modo examen';
  }

  const contenedor = document.getElementById('preguntasContainer');
  if (!contenedor || typeof PREGUNTAS === 'undefined') return;

  // Renderizado de las preguntas
  PREGUNTAS.forEach((preg, idx) => {
    const tieneImg = Boolean(preg.imagen);
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
      ? `<div class="pregunta-media"><img src="${preg.imagen}" alt="Imagen pregunta ${idx + 1}"></div>`
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

  function marcarCorreccionPregunta(idx, seleccion) {
    const correcta = PREGUNTAS[idx].correcta;
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

  window.corregirTest = function () {
    let aciertos = 0;

    PREGUNTAS.forEach((preg, idx) => {
      const seleccionado = document.querySelector(`input[name="p_${idx}"]:checked`);
      const valor = seleccionado ? Number(seleccionado.value) : -1;

      if (valor === preg.correcta) {
        aciertos++;
      }
      marcarCorreccionPregunta(idx, valor);
    });

    // Bloquear radios tras corregir
    contenedor.querySelectorAll('input[type="radio"]').forEach(r => r.disabled = true);

    // Guardar en localStorage (y listo para exportar a .json)
    const reg = typeof registrarResultado === 'function'
      ? registrarResultado(TEST_ID, aciertos, PREGUNTAS.length)
      : { aciertos, fallos: PREGUNTAS.length - aciertos, intentos: 1 };

    const panel = document.getElementById('resultadoPanel');
    const esApto = reg.fallos <= 3;
    panel.className = `resultado-panel ${esApto ? 'apto' : 'no-apto'}`;
    panel.style.display = 'block';
    panel.innerHTML = `
      <strong>${esApto ? '¡APTO!' : 'NO APTO'}</strong> —
      Aciertos: <strong>${reg.aciertos}</strong> / ${PREGUNTAS.length} |
      Fallos: <strong>${reg.fallos}</strong> |
      Veces realizado: <strong>${reg.intentos}</strong>
    `;

    const btnVolver = document.getElementById('btnVolver');
    if (btnVolver) btnVolver.style.display = 'inline-block';

    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
})();
