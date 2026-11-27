#!/usr/bin/env node
/**
 * @module
 * @remarks
 * Aplica correcciones pendientes de Supabase a los JSON de tests.
 *
 * aplicar_flags.js · aplica en lote las correcciones de preguntas guardadas en Supabase
 * sobre data/test_XXX.json y las marca como aplicadas.
 *
 * Requisitos: Node 18+ (fetch nativo). Sin dependencias.
 *
 *   export SUPABASE_URL="https://xxxx.supabase.co"
 *   export SUPABASE_SERVICE_ROLE_KEY="eyJ..."        # ¡secreta! nunca en el navegador ni en git
 *   node scripts/aplicar_flags.js            # aplica
 *   node scripts/aplicar_flags.js --dry-run  # solo muestra qué haría
 *   node scripts/aplicar_flags.js --data-dir ruta/a/data
 */
'use strict';

/**
 * Fila de corrección pendiente de la tabla de flags.
 * @typedef {Object} FlagPregunta
 * @property {string|number} id Identificador de la fila.
 * @property {string} pregunta_id Identificador de la pregunta.
 * @property {number} test_id Identificador del test.
 * @property {number} pregunta_idx Índice de la pregunta en el JSON.
 * @property {string} enunciado Texto corregido de la pregunta.
 * @property {string[]} opciones Opciones corregidas.
 * @property {number} correcta Índice de la respuesta correcta.
 * @property {string} [explicacion] Explicación opcional de la respuesta.
 * @property {string} [nota] Nota opcional asociada a la corrección.
 */

/**
 * Pregunta serializada en un archivo de test.
 * @typedef {Object} PreguntaJSON
 * @property {string} [id] Identificador de la pregunta.
 * @property {string} [texto] Enunciado de la pregunta.
 * @property {string[]} [opciones] Opciones de respuesta.
 * @property {number} [correcta] Índice de la respuesta correcta.
 * @property {string} [explicacion] Explicación de la respuesta.
 * @property {boolean} [corregida] Indica si la pregunta ha sido corregida.
 * @property {*} [correcta_detectada] Respuesta detectada previamente.
 */

/**
 * Estructura admitida para el JSON de un test.
 * @typedef {PreguntaJSON[]|{preguntas: PreguntaJSON[], respuestas_verificadas?: boolean}} TestJSON
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TABLA = 'flags_preguntas';
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const idxDir = args.indexOf('--data-dir');
const DATA_DIR = path.resolve(idxDir >= 0 && args[idxDir + 1] ? args[idxDir + 1] : path.join(__dirname, '..', 'data'));

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan variables de entorno SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const cabeceras = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json'
};

/**
 * Envía una solicitud a la API REST de Supabase.
 * @param {string} ruta Ruta relativa del recurso REST.
 * @param {RequestInit} [opciones={}] Opciones de la solicitud HTTP.
 * @returns {Promise<Response>} Respuesta HTTP de Supabase.
 * @throws {Error} Si la solicitud falla o Supabase responde con un estado no satisfactorio.
 */
async function pedir(ruta, opciones = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, { ...opciones, headers: { ...cabeceras, ...(opciones.headers || {}) } });
  if (!resp.ok) {
    throw new Error(`Supabase respondió ${resp.status} en ${ruta}: ${(await resp.text()).slice(0, 300)}`);
  }
  return resp;
}

// Descarga todas las filas pendientes (paginando de 1000 en 1000)
/**
 * Descarga todas las correcciones todavía no aplicadas.
 * @returns {Promise<FlagPregunta[]>} Filas pendientes ordenadas por fecha de actualización.
 * @throws {Error} Si falla una solicitud o la respuesta no puede interpretarse como JSON.
 */
async function descargarPendientes() {
  const filas = [];
  const PAGINA = 1000;
  for (let desde = 0; ; desde += PAGINA) {
    const resp = await pedir(`${TABLA}?aplicado=eq.false&select=*&order=updated_at.asc&limit=${PAGINA}&offset=${desde}`);
    const lote = await resp.json();
    filas.push(...lote);
    if (lote.length < PAGINA) break;
  }
  return filas;
}

// Valida una fila; devuelve un mensaje de error o null si es aplicable
/**
 * Comprueba que una fila contiene datos aplicables a una pregunta existente.
 * @param {FlagPregunta} fila Corrección que se va a validar.
 * @param {PreguntaJSON|undefined|null} pregunta Pregunta destino, si existe.
 * @returns {string|null} Motivo de rechazo, o {@code null} si la fila es válida.
 */
function validar(fila, pregunta) {
  if (!pregunta) return `la pregunta nº ${fila.pregunta_idx + 1} no existe en el JSON`;
  const { enunciado, opciones, correcta } = fila;
  if (typeof enunciado !== 'string' || !enunciado.trim()) return 'enunciado vacío';
  if (!Array.isArray(opciones) || opciones.length < 2 || opciones.length > 3) return 'debe haber 2 o 3 opciones';
  if (opciones.some((o) => typeof o !== 'string' || !o.trim())) return 'hay opciones vacías';
  if (!Number.isInteger(correcta) || correcta < 0 || correcta >= opciones.length) return 'respuesta correcta fuera de rango';
  return null;
}

/**
 * Busca el archivo JSON de un test, probando su identificador con y sin relleno.
 * @param {number|string} testId Identificador del test.
 * @returns {Promise<string|null>} Ruta encontrada o {@code null} si no existe.
 */
async function localizarJSON(testId) {
  for (const nombre of new Set([String(testId).padStart(3, '0'), String(testId)])) {
    const ruta = path.join(DATA_DIR, `test_${nombre}.json`);
    try {
      await fs.access(ruta);
      return ruta;
    } catch { /* se prueba el siguiente nombre */ }
  }
  return null;
}

// Escritura atómica: archivo temporal + rename
/**
 * Escribe el contenido en un temporal y lo renombra sobre el archivo de destino.
 * @param {string} ruta Ruta del archivo que se actualizará.
 * @param {string} texto Contenido que se escribirá en UTF-8.
 * @returns {Promise<void>} Se resuelve cuando el reemplazo termina.
 * @throws {Error} Si falla la escritura o el renombrado.
 */
async function escribirAtomico(ruta, texto) {
  const tmp = `${ruta}.tmp-${process.pid}`;
  await fs.writeFile(tmp, texto, 'utf8');
  await fs.rename(tmp, ruta);
}

/**
 * Marca como aplicadas las filas indicadas, en lotes de hasta cien IDs.
 * @param {(string|number)[]} ids Identificadores de las filas que se actualizarán.
 * @returns {Promise<void>} Se resuelve cuando todos los lotes se han enviado.
 * @throws {Error} Si falla alguna solicitud de actualización.
 */
async function marcarAplicadas(ids) {
  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100);
    await pedir(`${TABLA}?id=in.(${lote.join(',')})`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ aplicado: true, aplicado_at: new Date().toISOString() })
    });
  }
}

/**
 * Descarga, valida y aplica las correcciones pendientes a los archivos de tests.
 * @returns {Promise<void>} Se resuelve al finalizar el procesamiento.
 * @throws {Error} Si falla una operación de red, lectura o escritura no recuperable.
 */
async function main() {
  const filas = await descargarPendientes();
  if (!filas.length) {
    console.log('No hay correcciones pendientes.');
    return;
  }
  console.log(`${filas.length} corrección(es) pendiente(s)${DRY_RUN ? ' (dry-run: no se escribe nada)' : ''}.`);

  // Agrupar por test; si hay varias filas para la misma pregunta, gana la más reciente
  const porTest = new Map();
  for (const f of filas) {
    if (!porTest.has(f.test_id)) porTest.set(f.test_id, []);
    porTest.get(f.test_id).push(f);
  }

  const idsAplicables = [];
  let aplicadas = 0;
  let omitidas = 0;

  for (const [testId, lista] of [...porTest].sort((a, b) => a[0] - b[0])) {
    const ruta = await localizarJSON(testId);
    if (!ruta) {
      console.warn(`  ✗ Test ${testId}: no existe data/test_${String(testId).padStart(3, '0')}.json (se deja pendiente)`);
      omitidas += lista.length;
      continue;
    }

    const original = await fs.readFile(ruta, 'utf8');
    let data;
    try {
      data = JSON.parse(original);
    } catch (e) {
      console.warn(`  ✗ ${path.basename(ruta)}: JSON inválido (${e.message}); se deja pendiente`);
      omitidas += lista.length;
      continue;
    }
    const preguntas = Array.isArray(data) ? data : data.preguntas;
    if (!Array.isArray(preguntas)) {
      console.warn(`  ✗ ${path.basename(ruta)}: no contiene "preguntas"; se deja pendiente`);
      omitidas += lista.length;
      continue;
    }

    let cambiosEnArchivo = 0;
    for (const fila of lista) {
      const p = preguntas[fila.pregunta_idx];
      const error = validar(fila, p);
      if (error) {
        console.warn(`  ✗ ${fila.pregunta_id}: ${error} (se deja pendiente)`);
        omitidas++;
        continue;
      }
      p.texto = fila.enunciado.trim();
      p.opciones = fila.opciones.map((o) => o.trim());
      p.correcta = fila.correcta;
      if (typeof fila.explicacion === 'string' && fila.explicacion.trim()) p.explicacion = fila.explicacion.trim();
      delete p.correcta_detectada; // ya no es una lectura de OCR: la respuesta está verificada a mano
      p.corregida = true;
      cambiosEnArchivo++;
      aplicadas++;
      idsAplicables.push(fila.id);
      console.log(`  ✓ ${fila.pregunta_id} corregida${fila.nota ? ` · nota: ${fila.nota}` : ''}`);
    }

    if (cambiosEnArchivo && !DRY_RUN) {
      // Protege el test para que procesar_capturas.py no lo regenere encima de las correcciones
      if (!Array.isArray(data)) data.respuestas_verificadas = true;
      const finLinea = /\r?\n$/.test(original) ? '\n' : '';
      await escribirAtomico(ruta, JSON.stringify(data, null, 2) + finLinea);
      console.log(`  → ${path.basename(ruta)} actualizado (${cambiosEnArchivo})`);
    }
  }

  if (!DRY_RUN && idsAplicables.length) {
    await marcarAplicadas(idsAplicables);
    console.log(`Marcadas ${idsAplicables.length} fila(s) como aplicadas en Supabase.`);
  }
  console.log(`Resumen: ${aplicadas} aplicadas, ${omitidas} omitidas.`);
  if (omitidas) process.exitCode = 2;
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
