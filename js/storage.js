const STORAGE_KEY = 'todotest_youtube_90_v1';

function obtenerProgreso() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function guardarProgreso(datos) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(datos, null, 2));
}

function fechaHoyFormato() {
  const hoy = new Date();
  const d = String(hoy.getDate()).padStart(2, '0');
  const m = String(hoy.getMonth() + 1).padStart(2, '0');
  const y = hoy.getFullYear();
  return `${d}/${m}/${y}`;
}

/**
 * Llamar al terminar un test:
 * registrarResultado(1, 29, 30) -> guarda test_001 con 29 aciertos, 1 fallo, +1 intento y fecha de hoy
 */
function registrarResultado(numTest, aciertos, totalPreguntas = 30) {
  const datos = obtenerProgreso();
  const numStr = String(numTest).padStart(3, '0');
  const clave = `test_${numStr}`;
  const previo = datos[clave] || { intentos: 0, aciertos: 0, fallos: 0, total: totalPreguntas, ultimo: '' };

  const fallos = Math.max(0, totalPreguntas - aciertos);

  datos[clave] = {
    intentos: previo.intentos + 1,
    aciertos: aciertos,
    fallos: fallos,
    total: totalPreguntas,
    ultimo: fechaHoyFormato()
  };

  guardarProgreso(datos);
  return datos[clave];
}

async function exportarJSON() {
  const contenido = JSON.stringify(obtenerProgreso(), null, 2);

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'resultados_tests.json',
        types: [{ description: 'Archivo JSON', accept: { 'application/json': ['.json'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(contenido);
      await writable.close();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }

  const blob = new Blob([contenido], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'resultados_tests.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importarJSON(archivo, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const datos = JSON.parse(e.target.result);
      guardarProgreso(datos);
      if (callback) callback();
    } catch {
      alert('El archivo no es un JSON válido.');
    }
  };
  reader.readAsText(archivo);
}
