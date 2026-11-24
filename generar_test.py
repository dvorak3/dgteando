import os

os.makedirs("tests", exist_ok=True)

PLANTILLA = """<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test {num_str}</title>
  <style>
    body {{ font-family: "Roboto", Arial, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; color: #333; }}
    .cabecera {{ background: #367cb8; color: #fff; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }}
    .cabecera a {{ color: #fff; text-decoration: none; font-size: 14px; }}
    .pregunta {{ border-bottom: 1px solid #e6e6e6; padding: 16px 0; }}
    label {{ display: block; margin: 8px 0; cursor: pointer; }}
    .btn-fin {{ background: #e67e22; color: #fff; border: none; padding: 10px 20px; font-size: 15px; cursor: pointer; margin-top: 16px; }}
    .feedback {{ margin-top: 8px; font-size: 13px; font-weight: bold; }}
    .ok {{ color: #4d8a1f; }}
    .err {{ color: #d93838; }}
  </style>
</head>
<body>
  <div class="cabecera">
    <span>Test {num_str} — Modo: <strong id="lblModo"></strong></span>
    <a href="../index.html">← Volver a la lista</a>
  </div>

  <form id="formTest"></form>
  <button type="button" class="btn-fin" onclick="corregirTest()">Corregir test</button>
  <p id="resumen"></p>

  <script src="../storage.js"></script>
  <script>
    const NUM_TEST = {num};
    const params = new URLSearchParams(window.location.search);
    const MODO = params.get('modo') || 'examen';
    document.getElementById('lblModo').textContent = MODO;

    // Sustituye este array por las preguntas reales del Test {num_str}
    const PREGUNTAS = [
      {{ texto: "Pregunta 1 del test {num_str}", opciones: ["Respuesta A", "Respuesta B", "Respuesta C"], correcta: 0 }},
      {{ texto: "Pregunta 2 del test {num_str}", opciones: ["Respuesta A", "Respuesta B", "Respuesta C"], correcta: 1 }}
    ];

    const form = document.getElementById('formTest');
    PREGUNTAS.forEach((p, idx) => {{
      const div = document.createElement('div');
      div.className = 'pregunta';
      div.innerHTML = `<p><strong>${{idx + 1}}. ${{p.texto}}</strong></p>` +
        p.opciones.map((op, i) => `
          <label>
            <input type="radio" name="p${{idx}}" value="${{i}}" onchange="alSeleccionar(${{idx}}, ${{i}})">
            ${{op}}
          </label>
        `).join('') +
        `<div class="feedback" id="fb${{idx}}"></div>`;
      form.appendChild(div);
    }});

    function alSeleccionar(idx, valor) {{
      if (MODO !== 'estudio') return;
      const fb = document.getElementById(`fb${{idx}}`);
      const esCorrecta = valor === PREGUNTAS[idx].correcta;
      fb.textContent = esCorrecta ? '¡Correcta!' : `Fallo. La correcta es: ${{PREGUNTAS[idx].opciones[PREGUNTAS[idx].correcta]}}`;
      fb.className = 'feedback ' + (esCorrecta ? 'ok' : 'err');
    }}

    function corregirTest() {{
      let aciertos = 0;
      PREGUNTAS.forEach((p, idx) => {{
        const sel = form.querySelector(`input[name="p${{idx}}"]:checked`);
        const fb = document.getElementById(`fb${{idx}}`);
        if (sel && Number(sel.value) === p.correcta) {{
          aciertos++;
          fb.textContent = '¡Correcta!';
          fb.className = 'feedback ok';
        }} else {{
          fb.textContent = `Fallo. La correcta es: ${{p.opciones[p.correcta]}}`;
          fb.className = 'feedback err';
        }}
      }});

      const reg = registrarResultado(NUM_TEST, aciertos, PREGUNTAS.length);
      document.getElementById('resumen').textContent =
        `Aciertos: ${{reg.aciertos}} | Fallos: ${{reg.fallos}} | Realizado: ${{reg.intentos}} ${{reg.intentos === 1 ? 'vez' : 'veces'}}`;
    }}
  </script>
</body>
</html>
"""

for i in range(1, 91):
    num_str = f"{i:03d}"
    with open(f"tests/test_{num_str}.html", "w", encoding="utf-8") as f:
        f.write(PLANTILLA.format(num=i, num_str=num_str))

print("Generados test_001.html a test_090.html en /tests")
