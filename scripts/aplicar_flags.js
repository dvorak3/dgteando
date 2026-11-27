#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const TABLA = 'flags_preguntas';
const BUCKET_IMAGENES = 'preguntas-pendientes';
const MAX_TAMANO_IMAGEN = 5 * 1024 * 1024;
const TIPOS_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TAMANO_PAGINA = 1000;
const TAMANO_LOTE_PATCH = 100;
const argumentos = process.argv.slice(2);
const MODO_MARCAR = argumentos.includes('--mark-applied');
const DIFERIR_MARCADO = argumentos.includes('--defer-mark');
const DRY_RUN = argumentos.includes('--dry-run');
const indiceDirectorio = argumentos.indexOf('--data-dir');
const DIRECTORIO_DATA = path.resolve(
  indiceDirectorio >= 0 && argumentos[indiceDirectorio + 1]
    ? argumentos[indiceDirectorio + 1]
    : path.join(__dirname, '..', 'data')
);
const indiceDirectorioImagenes = argumentos.indexOf('--img-dir');
const DIRECTORIO_IMAGENES = path.resolve(
  indiceDirectorioImagenes >= 0 && argumentos[indiceDirectorioImagenes + 1]
    ? argumentos[indiceDirectorioImagenes + 1]
    : path.join(__dirname, '..', 'img')
);

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ARCHIVO_IDS = process.env.FLAGS_APPLIED_IDS_FILE || '';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan las variables de entorno SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
if (MODO_MARCAR && !ARCHIVO_IDS) {
  console.error('Define FLAGS_APPLIED_IDS_FILE para marcar las filas aplicadas.');
  process.exit(1);
}
if (DIFERIR_MARCADO && !ARCHIVO_IDS) {
  console.error('Define FLAGS_APPLIED_IDS_FILE para guardar los IDs que se marcarán después del push.');
  process.exit(1);
}
if (MODO_MARCAR && DIFERIR_MARCADO) {
  console.error('Usa solo uno de --mark-applied o --defer-mark.');
  process.exit(1);
}

const cabeceras = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json'
};

async function pedir(ruta, opciones = {}) {
  const respuesta = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
    ...opciones,
    headers: { ...cabeceras, ...(opciones.headers || {}) }
  });
  if (!respuesta.ok) {
    throw new Error(`Supabase respondió ${respuesta.status} en ${ruta}: ${(await respuesta.text()).slice(0, 300)}`);
  }
  return respuesta;
}

async function descargarPendientes() {
  const filas = [];
  for (let offset = 0; ; offset += TAMANO_PAGINA) {
    const consulta = new URLSearchParams({
      aplicado: 'eq.false',
      select: 'id,pregunta_id,test_id,pregunta_idx,enunciado,opciones,correcta,explicacion,nota,es_nueva,imagen_storage_path,updated_at',
      order: 'updated_at.asc',
      limit: String(TAMANO_PAGINA),
      offset: String(offset)
    });
    const lote = await (await pedir(`${TABLA}?${consulta}`)).json();
    filas.push(...lote);
    if (lote.length < TAMANO_PAGINA) return filas;
  }
}

function esPreguntaNueva(fila, pregunta, cantidadPreguntas) {
  return fila.es_nueva === true || (!pregunta && fila.pregunta_idx === cantidadPreguntas);
}

function validar(fila, pregunta, cantidadPreguntas) {
  if (esPreguntaNueva(fila, pregunta, cantidadPreguntas)) {
    const yaAplicada = pregunta && String(pregunta.id) === String(fila.pregunta_id);
    if (!yaAplicada && fila.pregunta_idx !== cantidadPreguntas) {
      return `la pregunta nueva debe añadirse al final (índice esperado ${cantidadPreguntas})`;
    }
  } else if (!pregunta) {
    return `la pregunta nº ${fila.pregunta_idx + 1} no existe en el JSON`;
  }
  if (typeof fila.enunciado !== 'string' || !fila.enunciado.trim()) return 'enunciado vacío';
  if (!Array.isArray(fila.opciones) || fila.opciones.length < 2 || fila.opciones.length > 3) {
    return 'debe haber 2 o 3 opciones';
  }
  if (fila.opciones.some((opcion) => typeof opcion !== 'string' || !opcion.trim())) {
    return 'hay opciones vacías';
  }
  if (!Number.isInteger(fila.correcta) || fila.correcta < 0 || fila.correcta >= fila.opciones.length) {
    return 'respuesta correcta fuera de rango';
  }
  if (!Number.isInteger(fila.test_id) || fila.test_id < 1
      || !Number.isInteger(fila.pregunta_idx) || fila.pregunta_idx < 0) {
    return 'identificador de test o índice no válido';
  }
  return null;
}

function nombreImagen(testId, preguntaIdx, storagePath, tipo) {
  const hash = crypto.createHash('sha256').update(storagePath).digest('hex').slice(0, 12);
  const extension = tipo === 'image/jpeg' ? 'jpg' : tipo.split('/')[1];
  return `test_${String(testId).padStart(3, '0')}_pregunta_${preguntaIdx + 1}_${hash}.${extension}`;
}

async function descargarImagen(storagePath) {
  const segmentos = storagePath.split('/');
  if (!storagePath || segmentos.some((segmento) => !segmento || segmento === '.' || segmento === '..')) {
    throw new Error('La ruta de imagen de Storage no es válida.');
  }
  const ruta = segmentos.map(encodeURIComponent).join('/');
  const respuesta = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET_IMAGENES}/${ruta}`,
    { headers: cabeceras }
  );
  if (!respuesta.ok) {
    throw new Error(`No se pudo descargar la imagen de Storage (${respuesta.status}): ${(await respuesta.text()).slice(0, 200)}`);
  }
  const tipo = (respuesta.headers.get('content-type') || '').split(';')[0].trim();
  if (!TIPOS_IMAGEN.has(tipo)) throw new Error(`Tipo de imagen no permitido en Storage: ${tipo || 'desconocido'}.`);
  const contenido = Buffer.from(await respuesta.arrayBuffer());
  if (!contenido.length || contenido.length > MAX_TAMANO_IMAGEN) {
    throw new Error('La imagen descargada está vacía o supera los 5 MB.');
  }
  return { tipo, contenido };
}

async function escribirImagen(destino, contenido) {
  await fs.mkdir(path.dirname(destino), { recursive: true });
  const temporal = `${destino}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporal, contenido);
    await fs.rename(temporal, destino);
  } catch (error) {
    await fs.rm(temporal, { force: true });
    throw error;
  }
}

async function localizarJSON(testId) {
  for (const nombre of new Set([String(testId).padStart(3, '0'), String(testId)])) {
    const ruta = path.join(DIRECTORIO_DATA, `test_${nombre}.json`);
    try {
      await fs.access(ruta);
      return ruta;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function escribirAtomico(ruta, texto) {
  const temporal = `${ruta}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporal, texto, 'utf8');
    await fs.rename(temporal, ruta);
  } catch (error) {
    await fs.rm(temporal, { force: true });
    throw error;
  }
}

function elegirUltimaCorreccion(filas) {
  const porPregunta = new Map();
  for (const fila of filas) {
    if (!porPregunta.has(fila.pregunta_id)) porPregunta.set(fila.pregunta_id, []);
    porPregunta.get(fila.pregunta_id).push(fila);
  }
  return [...porPregunta.values()].map((grupo) => {
    grupo.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return { ganadora: grupo[0], ids: grupo.map((fila) => fila.id) };
  });
}

async function marcarAplicadas(ids) {
  for (let inicio = 0; inicio < ids.length; inicio += TAMANO_LOTE_PATCH) {
    const lote = ids.slice(inicio, inicio + TAMANO_LOTE_PATCH);
    const consulta = new URLSearchParams({
      id: `in.(${lote.join(',')})`,
      select: 'id'
    });
    await pedir(`${TABLA}?${consulta}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ aplicado: true, aplicado_at: new Date().toISOString() })
    });
  }
}

async function marcarDesdeArchivo() {
  let ids;
  try {
    ids = JSON.parse(await fs.readFile(ARCHIVO_IDS, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('No hay IDs pendientes de marcar.');
      return;
    }
    throw error;
  }
  if (!Array.isArray(ids) || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('El archivo de IDs pendientes contiene datos no válidos.');
  }
  if (ids.length) await marcarAplicadas(ids);
  await fs.rm(ARCHIVO_IDS, { force: true });
  console.log(`Marcadas ${ids.length} fila(s) como aplicadas en Supabase.`);
}

async function aplicarPendientes() {
  const filas = await descargarPendientes();
  if (!filas.length) {
    console.log('No hay correcciones pendientes.');
    if (DIFERIR_MARCADO) await fs.writeFile(ARCHIVO_IDS, '[]', 'utf8');
    return;
  }

  console.log(`${filas.length} fila(s) pendiente(s)${DRY_RUN ? ' (dry-run)' : ''}.`);
  const ultimas = elegirUltimaCorreccion(filas);
  const porTest = new Map();
  for (const correccion of ultimas) {
    const { ganadora, ids } = correccion;
    if (!porTest.has(ganadora.test_id)) porTest.set(ganadora.test_id, []);
    porTest.get(ganadora.test_id).push({ ganadora, ids });
  }

  const idsAplicables = [];
  let aplicadas = 0;
  let omitidas = 0;

  for (const [testId, correcciones] of [...porTest].sort((a, b) => a[0] - b[0])) {
    const ruta = await localizarJSON(testId);
    if (!ruta) {
      console.warn(`No existe el JSON del test ${testId}; sus correcciones siguen pendientes.`);
      omitidas += correcciones.length;
      continue;
    }

    const original = await fs.readFile(ruta, 'utf8');
    let data;
    try {
      data = JSON.parse(original);
    } catch (error) {
      console.warn(`${path.basename(ruta)} es JSON inválido (${error.message}); las correcciones siguen pendientes.`);
      omitidas += correcciones.length;
      continue;
    }
    const preguntas = Array.isArray(data) ? data : data && data.preguntas;
    if (!Array.isArray(preguntas)) {
      console.warn(`${path.basename(ruta)} no contiene una lista de preguntas; las correcciones siguen pendientes.`);
      omitidas += correcciones.length;
      continue;
    }

    let cambios = 0;
    for (const correccion of correcciones) {
      const { ganadora, ids } = correccion;
      let pregunta = preguntas[ganadora.pregunta_idx];
      const error = validar(ganadora, pregunta, preguntas.length);
      if (error) {
        console.warn(`${ganadora.pregunta_id}: ${error}; la corrección sigue pendiente.`);
        omitidas++;
        continue;
      }

      const esNueva = esPreguntaNueva(ganadora, pregunta, preguntas.length);
      const esNuevaNoAplicada = esNueva
        && (!pregunta || String(pregunta.id) !== String(ganadora.pregunta_id));
      if (esNuevaNoAplicada) {
        pregunta = { id: ganadora.pregunta_id };
        preguntas.push(pregunta);
      }

      pregunta.texto = ganadora.enunciado.trim();
      pregunta.opciones = ganadora.opciones.map((opcion) => opcion.trim());
      pregunta.correcta = ganadora.correcta;
      if (typeof ganadora.explicacion === 'string' && ganadora.explicacion.trim()) {
        pregunta.explicacion = ganadora.explicacion.trim();
      } else {
        delete pregunta.explicacion;
      }
      if (ganadora.imagen_storage_path) {
        let tipo = 'image/jpeg';
        let contenido = null;
        if (!DRY_RUN) {
          const descarga = await descargarImagen(ganadora.imagen_storage_path);
          tipo = descarga.tipo;
          contenido = descarga.contenido;
        } else {
          const extension = path.extname(ganadora.imagen_storage_path).toLowerCase();
          tipo = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
        }
        const archivo = nombreImagen(testId, ganadora.pregunta_idx, ganadora.imagen_storage_path, tipo);
        pregunta.imagen = path.posix.join('..', 'img', archivo);
        if (contenido) {
          await escribirImagen(path.join(DIRECTORIO_IMAGENES, archivo), contenido);
        }
      }
      delete pregunta.correcta_detectada;
      pregunta.corregida = true;
      cambios++;
      aplicadas++;
      idsAplicables.push(...ids);
      console.log(`${esNueva ? 'Añadida' : 'Aplicada'} ${ganadora.pregunta_id}.`);
    }

    if (cambios && !DRY_RUN) {
      if (!Array.isArray(data)) data.respuestas_verificadas = true;
      const finLinea = /\r?\n$/.test(original) ? '\n' : '';
      await escribirAtomico(ruta, JSON.stringify(data, null, 2) + finLinea);
      console.log(`${path.basename(ruta)} actualizado (${cambios} pregunta(s)).`);
    }
  }

  if (!DRY_RUN) {
    if (DIFERIR_MARCADO) {
      await fs.writeFile(ARCHIVO_IDS, JSON.stringify(idsAplicables), 'utf8');
    } else if (idsAplicables.length) {
      await marcarAplicadas(idsAplicables);
    }
  }
  console.log(`Resumen: ${aplicadas} aplicadas, ${omitidas} omitidas.`);
}

async function main() {
  if (MODO_MARCAR) {
    await marcarDesdeArchivo();
    return;
  }
  await aplicarPendientes();
}

main().catch((error) => {
  console.error('Error aplicando correcciones:', error.message);
  process.exitCode = 1;
});
