import os
import re
import json
import glob
import argparse
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CARPETA_CAPTURAS_DEFAULT = os.path.join(BASE_DIR, "capturas_largas", "capturas")
CARPETA_IMG = os.path.join(BASE_DIR, "img")
CARPETA_DATA = os.path.join(BASE_DIR, "data")
CARPETA_TESTS = os.path.join(BASE_DIR, "tests")

PLANTILLA_HTML = """<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test nº {num_int}</title>
  <link rel="stylesheet" href="../css/test.css">
</head>
<body>

  <main class="test-column">
    <div class="test-title-row">
      <h1 class="test-title">test <span class="num">nº {num_int}</span></h1>
      <span class="modo-badge" id="lblModo">Modo examen</span>
    </div>

    <form id="formTest">
      <div id="preguntasContainer"></div>

      <div class="corregir-box">
        <button type="button" class="btn-corregir" onclick="corregirTest()">Corregir el test</button>
        <a href="../index.html" class="btn-volver" id="btnVolver">Volver a la lista</a>
      </div>

      <div class="resultado-panel" id="resultadoPanel"></div>
    </form>
  </main>

  <script>
    const TEST_ID = {num_int};
    const PREGUNTAS = {preguntas_json};
  </script>
  <script src="../js/storage.js"></script>
  <script src="../js/test_engine.js"></script>
</body>
</html>
"""

PATRON_OPCION = re.compile(r"^(?:[Oo0Q\(\)\[\]•·]\s*)?([abcABC])[\)\.]\s*(.*)")
PATRON_OPCION_SOLA = re.compile(r"^(?:[Oo0Q\(\)\[\]•·]\s*)?([abcABC])[\)\.]?$")
PATRON_UI_CORTE = re.compile(r"^(?:ayuda|explicaci[oó]n:?)$", re.IGNORECASE)


def escanear_ocr_completo(img_bgr, ocr_engine):
    """Escanea la imagen por ventanas proporcionales al ancho y devuelve todas las cajas OCR."""
    h, w, _ = img_bgr.shape
    alto_ventana = max(900, int(w * 1.6))
    solape = int(alto_ventana * 0.25)
    paso = max(450, alto_ventana - solape)

    cajas_globales = []
    patron_num = re.compile(r"^(\d{1,2})[\.\-\)\s]+")

    for y_ini in range(0, h, paso):
        y_fin = min(h, y_ini + alto_ventana)
        trozo = img_bgr[y_ini:y_fin, :]
        res, _ = ocr_engine(trozo)
        if not res:
            continue

        for bbox, txt, conf in res:
            txt_clean = txt.strip()
            if not txt_clean:
                continue

            x1 = min(pt[0] for pt in bbox)
            y1 = y_ini + min(pt[1] for pt in bbox)
            x2 = max(pt[0] for pt in bbox)
            y2 = y_ini + max(pt[1] for pt in bbox)

            duplicada = False
            for prev in cajas_globales:
                if abs(prev["y1"] - y1) < 12 and abs(prev["x1"] - x1) < 18:
                    duplicada = True
                    break
            if duplicada:
                continue

            num_detectado = None
            m_num = patron_num.match(txt_clean)
            if m_num:
                val = int(m_num.group(1))
                if 1 <= val <= 30:
                    num_detectado = val
            elif re.match(r"^\d{1,2}[\.\-\)]?$", txt_clean):
                val = int(re.sub(r"\D", "", txt_clean))
                if 1 <= val <= 30:
                    num_detectado = val

            cajas_globales.append({
                "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                "txt": txt_clean,
                "num": num_detectado
            })

    return cajas_globales


def localizar_anclas_y_columnas(cajas, img_w, img_h):
    """Encuentra las coordenadas Y de las preguntas 1..30 y los límites horizontales."""
    candidatas = [c for c in cajas if c["num"] is not None]
    if not candidatas:
        return 0, img_w, img_w, []

    xs = sorted(c["x1"] for c in candidatas)
    x_margen = xs[len(xs) // 2]
    tol_x = max(30, img_w * 0.04)

    anclas_raw = [c for c in candidatas if abs(c["x1"] - x_margen) <= tol_x]
    anclas_raw.sort(key=lambda c: c["y1"])

    anclas = []
    ultimo_num = 0
    ultimo_y = -1
    for c in anclas_raw:
        if c["num"] > ultimo_num and c["y1"] > ultimo_y + 20:
            anclas.append((c["num"], int(c["y1"])))
            ultimo_num = c["num"]
            ultimo_y = c["y1"]

    if not anclas:
        return 0, img_w, img_w, []

    y_min = anclas[0][1] - 10
    y_max = min(img_h, anclas[-1][1] + int(img_w * 0.5))

    cajas_opciones = [
        c for c in cajas
        if y_min <= c["y1"] <= y_max and PATRON_OPCION.match(c["txt"])
    ]

    if cajas_opciones:
        xs_op = sorted(c["x1"] for c in cajas_opciones)
        x_inicio_op = xs_op[len(xs_op) // 2]
        xs_fin_op = [c["x2"] for c in cajas_opciones if c["x2"] < x_inicio_op + img_w * 0.55]
        x_fin_texto = max(xs_fin_op) if xs_fin_op else int(x_inicio_op + img_w * 0.45)
    else:
        x_fin_texto = int(x_margen + img_w * 0.50)

    x_col_izq = max(0, int(x_margen - img_w * 0.015))
    x_col_der = min(img_w, int(x_fin_texto + (x_fin_texto - x_col_izq) * 0.55))

    return x_col_izq, x_col_der, x_fin_texto, anclas


def limpiar_caja_explicacion_y_ayuda(bloque_bgr, cajas_bloque, y_offset):
    """Corta el bloque si detecta 'Explicación', botón 'Ayuda' o el recuadro naranja/gris."""
    h, w, _ = bloque_bgr.shape
    corte_y = h

    for c in cajas_bloque:
        y_rel = int(c["y1"] - y_offset)
        if y_rel > int(h * 0.35) and PATRON_UI_CORTE.match(c["txt"].strip()):
            corte_y = min(corte_y, max(int(h * 0.35), y_rel - 8))

    hsv = cv2.cvtColor(bloque_bgr[:corte_y, :], cv2.COLOR_BGR2HSV)
    h_act = hsv.shape[0]
    zona_izq_hsv = hsv[:, :int(w * 0.35)]
    mask_naranja = (
        (zona_izq_hsv[:, :, 0] >= 8) & (zona_izq_hsv[:, :, 0] <= 24) &
        (zona_izq_hsv[:, :, 1] >= 120) & (zona_izq_hsv[:, :, 2] >= 170)
    )

    umbral_ancho = max(35, int(w * 0.04))
    filas_ok = mask_naranja.sum(axis=1) > umbral_ancho

    y_inicio_busqueda = int(h_act * 0.50)
    consecutivas = 0
    for y in range(y_inicio_busqueda, h_act):
        if filas_ok[y]:
            consecutivas += 1
            if consecutivas >= 10:
                corte_y = min(corte_y, max(y_inicio_busqueda, y - 13))
                break
        else:
            consecutivas = 0

    return bloque_bgr[:corte_y, :]


def extraer_imagen_derecha(bloque_bgr, x_inicio_img_rel, nombre_archivo):
    """Recorta la miniatura completa a la derecha del texto con margen blanco de seguridad."""
    h, w, _ = bloque_bgr.shape
    x_ini = max(0, min(w - 10, int(x_inicio_img_rel)))
    zona_der = bloque_bgr[:, x_ini:]
    if zona_der.shape[1] < 40:
        return None

    gray = cv2.cvtColor(zona_der, cv2.COLOR_BGR2GRAY)
    mask = gray < 245

    cols_con_contenido = np.where(mask.sum(axis=0) > max(4, int(h * 0.03)))[0]
    if len(cols_con_contenido) == 0:
        return None

    pad = 12
    x1 = max(0, int(cols_con_contenido[0]) - pad)
    x2_col = int(cols_con_contenido[0])
    for col in cols_con_contenido[1:]:
        if col - x2_col > 45:
            break
        x2_col = int(col)
    x2 = min(zona_der.shape[1], x2_col + pad)

    sub_mask = mask[:, x1:x2]
    area_minima = max(500, int((zona_der.shape[0] * (x2 - x1)) * 0.03))
    if sub_mask.sum() < area_minima:
        return None

    ys = np.where(sub_mask.sum(axis=1) > 3)[0]
    if len(ys) == 0:
        return None
    y1 = max(0, int(ys.min()) - pad)
    y2 = min(h, int(ys.max()) + pad)

    if (x2 - x1) < 55 or (y2 - y1) < 40:
        return None

    miniatura = zona_der[y1:y2, x1:x2]

    hsv_min = cv2.cvtColor(miniatura, cv2.COLOR_BGR2HSV)
    gris_plano = (hsv_min[:, :, 1] < 18) & (hsv_min[:, :, 2] > 200)
    if (gris_plano.sum() / gris_plano.size) > 0.72:
        return None

    ruta_salida = os.path.join(CARPETA_IMG, nombre_archivo)
    cv2.imwrite(ruta_salida, miniatura, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return f"../img/{nombre_archivo}"


def medir_verde_opcion(bloque_bgr, y_top, y_bot, x_left, x_max_texto):
    """Mide píxeles verdes alrededor de la fila de la opción para detectar la correcta."""
    h, w, _ = bloque_bgr.shape
    margen_izq = max(24, int(w * 0.05))
    x1 = max(0, int(x_left) - margen_izq)
    x2 = min(w, int(x_max_texto))
    y1 = max(0, int(y_top) - 3)
    y2 = min(h, int(y_bot) + 3)

    if x2 <= x1 or y2 <= y1:
        return 0

    roi = bloque_bgr[y1:y2, x1:x2]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    mask_verde = (
        (hsv[:, :, 0] >= 35) & (hsv[:, :, 0] <= 95) &
        (hsv[:, :, 1] >= 25) & (hsv[:, :, 2] >= 90)
    )
    return int(mask_verde.sum())


def construir_pregunta_desde_cajas(bloque_bgr, cajas_bloque, x_offset, y_offset, x_fin_texto_abs):
    """Reconstruye enunciado y estrictamente 2 o 3 opciones (nunca 4)."""
    limite_x = x_fin_texto_abs + 8
    cajas_txt = [c for c in cajas_bloque if c["x1"] < limite_x]
    cajas_txt.sort(key=lambda c: (round((c["y1"] - y_offset) / 10), c["x1"]))

    enunciado_partes = []
    opciones = []
    scores_verde = []
    opcion_actual = None
    score_actual = 0
    ultima_letra = ""

    patron_num = re.compile(r"^(\d{1,2})[\.\-\)\s]+(.*)")

    def total_opciones_iniciadas():
        return len(opciones) + (1 if opcion_actual is not None else 0)

    for c in cajas_txt:
        txt = c["txt"].strip()
        if not txt or PATRON_UI_CORTE.match(txt):
            continue

        if not enunciado_partes and opcion_actual is None:
            if re.match(r"^\d{1,2}[\.\-\)]?$", txt):
                continue
            m_num = patron_num.match(txt)
            if m_num:
                txt = m_num.group(2).strip()
                if not txt:
                    continue

        puede_abrir_opcion = total_opciones_iniciadas() < 3
        m_sola = PATRON_OPCION_SOLA.match(txt)
        m_op = PATRON_OPCION.match(txt)

        if puede_abrir_opcion and m_sola and m_sola.group(1).lower() > ultima_letra:
            if opcion_actual is not None:
                opciones.append(opcion_actual.strip())
                scores_verde.append(score_actual)
            ultima_letra = m_sola.group(1).lower()
            opcion_actual = ""
            score_actual = medir_verde_opcion(
                bloque_bgr,
                c["y1"] - y_offset,
                c["y2"] - y_offset,
                c["x1"] - x_offset,
                x_fin_texto_abs - x_offset
            )
            continue

        if puede_abrir_opcion and m_op and m_op.group(1).lower() > ultima_letra:
            if opcion_actual is not None:
                opciones.append(opcion_actual.strip())
                scores_verde.append(score_actual)
            ultima_letra = m_op.group(1).lower()
            opcion_actual = m_op.group(2)
            score_actual = medir_verde_opcion(
                bloque_bgr,
                c["y1"] - y_offset,
                c["y2"] - y_offset,
                c["x1"] - x_offset,
                x_fin_texto_abs - x_offset
            )
        elif puede_abrir_opcion and re.match(r"^['\"`]?[Ii1l]?s\s*\(?e\s*[Oo0]\)?$", txt):
            if opcion_actual is not None:
                opciones.append(opcion_actual.strip())
                scores_verde.append(score_actual)
            opcion_actual = "Sí."
            score_actual = medir_verde_opcion(
                bloque_bgr,
                c["y1"] - y_offset,
                c["y2"] - y_offset,
                c["x1"] - x_offset,
                x_fin_texto_abs - x_offset
            )
        else:
            if opcion_actual is not None:
                opcion_actual = (opcion_actual + " " + txt).strip()
            else:
                enunciado_partes.append(txt)

    if opcion_actual is not None:
        opciones.append(opcion_actual.strip())
        scores_verde.append(score_actual)

    enunciado = " ".join(enunciado_partes).strip()
    if not enunciado or len(opciones) < 2:
        return None

    opciones = opciones[:3]
    scores_verde = scores_verde[:3]

    correcta_idx = 0
    if scores_verde and max(scores_verde) > 4:
        correcta_idx = int(np.argmax(scores_verde))

    return {
        "texto": enunciado,
        "opciones": opciones,
        "correcta": correcta_idx
    }


def reescanear_bloque_individual(bloque_bgr, x_offset, y_offset, x_fin_texto_abs, ocr_engine):
    """Fallback de alta precisión cuando una pregunta aislada perdió opciones en el escaneo global."""
    ancho_txt = min(bloque_bgr.shape[1], int(x_fin_texto_abs - x_offset + 15))
    recorte_txt = bloque_bgr[:, :ancho_txt]
    res, _ = ocr_engine(recorte_txt)
    if not res:
        return None

    cajas_local = []
    for bbox, txt, _conf in res:
        txt_clean = txt.strip()
        if not txt_clean:
            continue
        cajas_local.append({
            "x1": x_offset + min(pt[0] for pt in bbox),
            "y1": y_offset + min(pt[1] for pt in bbox),
            "x2": x_offset + max(pt[0] for pt in bbox),
            "y2": y_offset + max(pt[1] for pt in bbox),
            "txt": txt_clean,
            "num": None
        })
    return construir_pregunta_desde_cajas(bloque_bgr, cajas_local, x_offset, y_offset, x_fin_texto_abs)


def procesar_imagen_test(ruta_img, ocr_engine, debug=False):
    nombre_base = os.path.splitext(os.path.basename(ruta_img))[0]
    m_num = re.search(r"(\d+)", nombre_base)
    if not m_num:
        print(f"[AVISO] No se encontró número de test en '{ruta_img}'.")
        return

    num_int = int(m_num.group(1))
    num_str = f"{num_int:03d}"
    print(f"Procesando Test {num_str} ({os.path.basename(ruta_img)})...")

    img = cv2.imread(ruta_img)
    if img is None:
        print(f"  [ERROR] No se pudo leer {ruta_img}")
        return

    h, w, _ = img.shape
    cajas = escanear_ocr_completo(img, ocr_engine)
    x_izq, x_der, x_fin_texto, anclas = localizar_anclas_y_columnas(cajas, w, h)

    if debug:
        print(f"  [DEBUG] Resolución: {w}x{h} | x_izq={x_izq}, x_fin_texto={x_fin_texto}, x_der={x_der}")
        print(f"  [DEBUG] Anclas detectadas ({len(anclas)}): {anclas}")

    if not anclas:
        print(f"  [ERROR] No se detectaron preguntas numeradas en {ruta_img}")
        return

    preguntas = []
    altura_estimada = (
        int((anclas[-1][1] - anclas[0][1]) / max(1, len(anclas) - 1))
        if len(anclas) > 1 else int(w * 0.25)
    )

    for idx, (num_preg, y_start) in enumerate(anclas):
        y1 = max(0, y_start - 18)
        if idx + 1 < len(anclas):
            y2 = max(y1 + 30, anclas[idx + 1][1] - 10)
        else:
            y2 = min(h, y1 + int(altura_estimada * 1.35))

        cajas_bloque_raw = [
            c for c in cajas
            if (y1 - 6) <= c["y1"] < y2 and (x_izq - 10) <= c["x1"] <= x_der
        ]

        bloque_raw = img[y1:y2, x_izq:x_der]
        bloque = limpiar_caja_explicacion_y_ayuda(bloque_raw, cajas_bloque_raw, y1)
        y2_limpio = y1 + bloque.shape[0]

        cajas_bloque = [c for c in cajas_bloque_raw if c["y1"] < y2_limpio]

        datos_preg = construir_pregunta_desde_cajas(bloque, cajas_bloque, x_izq, y1, x_fin_texto)
        if not datos_preg:
            datos_preg = reescanear_bloque_individual(bloque, x_izq, y1, x_fin_texto, ocr_engine)

        if not datos_preg:
            if debug:
                print(f"  [DEBUG] Pregunta {num_preg} descartada. Cajas: {[c['txt'] for c in cajas_bloque]}")
            continue

        nombre_miniatura = f"test_{num_str}_p{num_preg:02d}.jpg"
        x_ini_img_rel = max(0, (x_fin_texto - x_izq) + 4)
        img_rel = extraer_imagen_derecha(bloque, x_ini_img_rel, nombre_miniatura)
        if img_rel:
            datos_preg["imagen"] = img_rel

        preguntas.append(datos_preg)

    ruta_json = os.path.join(CARPETA_DATA, f"test_{num_str}.json")
    with open(ruta_json, "w", encoding="utf-8") as f:
        json.dump({"test_id": num_int, "preguntas": preguntas}, f, ensure_ascii=False, indent=2)

    ruta_html = os.path.join(CARPETA_TESTS, f"test_{num_str}.html")
    html_final = PLANTILLA_HTML.format(
        num_int=num_int,
        preguntas_json=json.dumps(preguntas, ensure_ascii=False, indent=2)
    )
    with open(ruta_html, "w", encoding="utf-8") as f:
        f.write(html_final)

    print(f"  -> OK: {len(preguntas)} preguntas extraídas -> tests/test_{num_str}.html")


def recompilar_desde_json():
    os.makedirs(CARPETA_TESTS, exist_ok=True)
    archivos_json = sorted(glob.glob(os.path.join(CARPETA_DATA, "test_*.json")))
    if not archivos_json:
        print(f"No se encontraron archivos JSON en '{CARPETA_DATA}'.")
        return

    for ruta_json in archivos_json:
        with open(ruta_json, "r", encoding="utf-8") as f:
            data = json.load(f)
        num_int = data["test_id"]
        num_str = f"{num_int:03d}"
        ruta_html = os.path.join(CARPETA_TESTS, f"test_{num_str}.html")
        html_final = PLANTILLA_HTML.format(
            num_int=num_int,
            preguntas_json=json.dumps(data["preguntas"], ensure_ascii=False, indent=2)
        )
        with open(ruta_html, "w", encoding="utf-8") as f:
            f.write(html_final)
    print(f"Recompilados {len(archivos_json)} archivos HTML en tests/.")


def parsear_argumentos():
    parser = argparse.ArgumentParser(
        prog="procesar_capturas.py",
        description="Extrae preguntas, imágenes y respuestas correctas desde capturas largas de Todotest.",
        epilog=(
            "Ejemplos de uso:\n"
            "  python procesar_capturas.py                                    Procesa capturas_largas/capturas/\n"
            "  python procesar_capturas.py -i capturas_largas/capturas/test70.png\n"
            "  python procesar_capturas.py -i capturas_largas/capturas/test70.png --debug\n"
            "  python procesar_capturas.py --recompilar                      Regenera los .html desde data/*.json"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("-i", "--imagen", metavar="RUTA", help="Procesa una única imagen.")
    parser.add_argument("-c", "--carpeta", metavar="DIR", default=CARPETA_CAPTURAS_DEFAULT, help="Carpeta de capturas.")
    parser.add_argument("-r", "--recompilar", action="store_true", help="Regenera los .html desde data/*.json sin OCR.")
    parser.add_argument("-d", "--debug", action="store_true", help="Muestra trazas de diagnóstico del OCR y coordenadas.")
    return parser.parse_args()


if __name__ == "__main__":
    args = parsear_argumentos()

    if args.recompilar:
        recompilar_desde_json()
    else:
        os.makedirs(CARPETA_IMG, exist_ok=True)
        os.makedirs(CARPETA_DATA, exist_ok=True)
        os.makedirs(CARPETA_TESTS, exist_ok=True)

        ocr = RapidOCR()

        if args.imagen:
            if not os.path.isfile(args.imagen):
                print(f"[ERROR] No existe el archivo: {args.imagen}")
            else:
                procesar_imagen_test(args.imagen, ocr, debug=args.debug)
        else:
            if not os.path.isdir(args.carpeta):
                print(f"[ERROR] No existe la carpeta '{args.carpeta}'.")
            else:
                archivos = sorted(glob.glob(os.path.join(args.carpeta, "*.*")))
                imagenes = [f for f in archivos if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
                if not imagenes:
                    print(f"No se encontraron imágenes en '{args.carpeta}'.")
                else:
                    for archivo in imagenes:
                        procesar_imagen_test(archivo, ocr, debug=args.debug)
