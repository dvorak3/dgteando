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

MAX_PREGUNTAS = 30
ANCHO_REF = 1233          # ancho de las capturas con las que se calibraron los tamaños
UMBRAL_VERDE = 25         # píxeles verdes mínimos para dar una opción por correcta

_RADIO = r"[Oo0Q\(\)\[\]•·©@®◎○●¢]"   # lo que el OCR suele devolver para el círculo del radio-button
PATRON_OPCION = re.compile(rf"^(?:{_RADIO}\s*)?([abcABC])[\)\.]\s*(.*)")
PATRON_OPCION_SOLA = re.compile(rf"^(?:{_RADIO}\s*)?([abcABC])[\)\.]?$")

# Textos de la interfaz que NO forman parte de la pregunta. Se comparan por prefijo, así que
# "Explicación básica", "Explicación premium...", "Ver esquemas", "Corregir el test"... también cortan.
PATRON_UI_CORTE = re.compile(
    r"^(?:ayuda|explicaci.{1,2}n|ocultar|ver\s+esquemas|corregir\s+el\s+test|repetir\s+test|m[aá]s\s+dudas)(?!\w)",
    re.IGNORECASE,
)

# Número de pregunta: "12." / "12)" / "12 ¿Qué..." / "12" suelto.
# Exige puntuación (o mayúscula/¿ detrás) para NO confundir "4 fallos" del banner con la pregunta 4,
# y rechaza "3.500 kg" (punto seguido de dígito).
PATRON_NUM_CON_PUNTO = re.compile(r"^(\d{1,2})\s*[\.\)\-:](?!\d)\s*(.*)$")
PATRON_NUM_CON_ESPACIO = re.compile(r"^(\d{1,2})\s+([¿¡A-ZÁÉÍÓÚÑ].*)$")
PATRON_NUM_SOLO = re.compile(r"^(\d{1,2})\s*[\.\)]?$")


def detectar_numero_pregunta(txt):
    """Devuelve el nº de pregunta (1..MAX_PREGUNTAS) si el texto empieza como '12.' o '12 ¿Qué', si no None."""
    t = txt.strip()
    for patron in (PATRON_NUM_CON_PUNTO, PATRON_NUM_CON_ESPACIO, PATRON_NUM_SOLO):
        m = patron.match(t)
        if m:
            val = int(m.group(1))
            if 1 <= val <= MAX_PREGUNTAS:
                return val
            return None
    return None


# ------------------------------------------------------------------ signo "¿"
# El modelo de RapidOCR por defecto (chino/inglés) no tiene "¿" en su diccionario, así que NUNCA lo
# devuelve. Lo reconstruimos a partir del "?" final y de la estructura típica de las preguntas DGT.
_INTERROG = (
    r"(?:(?:en|a|de|con|para|por|sobre|hasta|desde)\s+)?"
    r"(?:qué|cuál(?:es)?|cuándo|dónde|cómo|quién(?:es)?|cuánt[oa]s?)(?!\w)"
)
_RE_INTERROG_ACENTUADA = re.compile(_INTERROG, re.IGNORECASE)
# primera palabra típica de una pregunta de sí/no: "¿Podrá circular...?", "¿Se podrá...?", "¿Es...?"
_VERBOS_INICIO = {
    "es", "son", "está", "están", "puede", "pueden", "podrá", "podrán", "podría", "podemos",
    "debe", "deben", "hay", "se", "existe", "afecta", "influye", "tiene", "tienen", "estará",
    "será", "serán", "autoriza", "permite", "obliga", "implica", "supone",
}


def _limpiar_basura_apertura(t):
    """Quita caracteres basura que el OCR suele poner donde iría el '¿' (al inicio y tras , . ; :)."""
    t = re.sub(r"^[\{\(\[¢£¡!?]+\s*", "", t)                        # basura delante del enunciado
    t = re.sub(r"^[a-zñáéíóú](?=[A-ZÁÉÍÓÚÑ](?:[a-záéíóúñ]|\s))", "", t)   # 'gEn' -> 'En', 'éA qué' -> 'A qué'
    t = re.sub(r"([,.;:]\s+)[\{\(\[¢£¡!?]+\s*(?=\w)", r"\1", t)      # ', {qué' -> ', qué'
    t = re.sub(r"([,.;:]\s+)[a-zñáéíóú](?=[A-ZÁÉÍÓÚÑ](?:[a-záéíóúñ]|\s))", r"\1", t)
    return t


def restaurar_signos_interrogacion(txt):
    """Inserta '¿' en un enunciado que termina en '?' pero no lo trae.

    Reglas (en orden):
      1. si una cláusula (inicio de texto o tras ', ' / '. ') empieza por 'qué/cuál/cómo/dónde...' -> ahí
         va el '¿' (se usa la última que cumpla);
      2. si el texto empieza por un verbo típico de pregunta sí/no (Podrá, Se, Es...) -> al principio;
      3. si hay una oración introductoria ('Para estacionar, ...?') -> tras la última coma/punto;
      4. si no hay nada de eso -> al principio.
    No toca textos que ya traen '¿' o que no contienen '?'.
    """
    t = _limpiar_basura_apertura(txt.strip())
    if t.count("?") != 1 or "¿" in t:
        return t.replace("¡", "¿") if "?" in t else t

    fin = t.rfind("?")
    candidatas = [0] + [m.end() for m in re.finditer(r"[,.;:]\s+", t[:fin])]

    for pos in reversed(candidatas):
        if _RE_INTERROG_ACENTUADA.match(t[pos:]):
            return t[:pos] + "¿" + t[pos:]

    primera = re.match(r"[^\W\d_]+", t)
    if primera and primera.group(0).lower() in _VERBOS_INICIO:
        return "¿" + t

    pos = candidatas[-1]
    return t[:pos] + "¿" + t[pos:]


def ordenar_en_lineas(cajas):
    """Ordena cajas OCR por líneas (agrupando por centro vertical) y dentro de cada línea por x.

    Sustituye al antiguo `round(y/10)`, que partía una misma línea en dos cuando su y caía en la frontera
    entre dos 'cubos' de 10 px y desordenaba la letra de la opción respecto a su texto.
    """
    ordenadas = sorted(cajas, key=lambda c: (c["y1"] + c["y2"]) / 2)
    lineas = []
    for c in ordenadas:
        cy = (c["y1"] + c["y2"]) / 2
        alto = max(8, c["y2"] - c["y1"])
        if lineas and abs(cy - lineas[-1]["cy"]) <= alto * 0.6:
            lineas[-1]["items"].append(c)
            n = len(lineas[-1]["items"])
            lineas[-1]["cy"] = (lineas[-1]["cy"] * (n - 1) + cy) / n
        else:
            lineas.append({"cy": cy, "items": [c]})
    resultado = []
    for linea in lineas:
        resultado.extend(sorted(linea["items"], key=lambda c: c["x1"]))
    return resultado


def escanear_ocr_completo(img_bgr, ocr_engine):
    """Escanea la imagen por ventanas proporcionales al ancho y devuelve todas las cajas OCR.

    Las ventanas se solapan un 25 %. Las líneas que quedan CORTADAS por el borde de una ventana se
    descartan (aparecerán completas en la ventana vecina gracias al solape): antes se conservaban
    truncadas y, al ser "duplicadas" de la versión completa, ésta se rechazaba.
    """
    h, w, _ = img_bgr.shape
    alto_ventana = max(900, int(w * 1.6))
    solape = int(alto_ventana * 0.25)
    paso = max(450, alto_ventana - solape)
    borde = 6

    cajas_globales = []

    for y_ini in range(0, h, paso):
        y_fin = min(h, y_ini + alto_ventana)
        trozo = img_bgr[y_ini:y_fin, :]
        alto_trozo = y_fin - y_ini
        res, _ = ocr_engine(trozo)
        if not res:
            continue

        n_previas = len(cajas_globales)   # sólo se deduplica contra ventanas ANTERIORES

        for bbox, txt, conf in res:
            txt_clean = txt.strip()
            if not txt_clean:
                continue

            y1_loc = min(pt[1] for pt in bbox)
            y2_loc = max(pt[1] for pt in bbox)
            if y_ini > 0 and y1_loc < borde:
                continue                      # cortada por arriba
            if y_fin < h and y2_loc > alto_trozo - borde:
                continue                      # cortada por abajo

            x1 = min(pt[0] for pt in bbox)
            y1 = y_ini + y1_loc
            x2 = max(pt[0] for pt in bbox)
            y2 = y_ini + y2_loc

            duplicada = False
            for prev in cajas_globales[:n_previas]:
                if abs(prev["y1"] - y1) < 12 and abs(prev["x1"] - x1) < 18:
                    duplicada = True
                    if len(txt_clean) > len(prev["txt"]):
                        prev.update(x1=x1, y1=y1, x2=x2, y2=y2, txt=txt_clean,
                                    num=detectar_numero_pregunta(txt_clean))
                    break
            if duplicada:
                continue

            cajas_globales.append({
                "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                "txt": txt_clean,
                "num": detectar_numero_pregunta(txt_clean),
            })

    return cajas_globales


def _cadena_creciente(candidatas):
    """Subsecuencia más larga de candidatas (ordenadas por y) con nº de pregunta estrictamente creciente.

    Es más robusta que el antiguo "tomo la primera y sólo acepto números mayores": una falsa detección
    temprana (p. ej. "4 fallos" del banner) ya no se come las preguntas 1-3, y un número mal leído por el
    OCR se descarta en lugar de arrastrar a todas las preguntas siguientes.
    """
    n = len(candidatas)
    if n == 0:
        return []
    mejor = [1] * n
    previo = [-1] * n
    for i in range(n):
        for j in range(i):
            if (candidatas[j]["num"] < candidatas[i]["num"]
                    and candidatas[i]["y1"] - candidatas[j]["y1"] > 20
                    and mejor[j] + 1 > mejor[i]):
                mejor[i] = mejor[j] + 1
                previo[i] = j
    i = max(range(n), key=lambda k: mejor[k])
    cadena = []
    while i != -1:
        cadena.append(candidatas[i])
        i = previo[i]
    return cadena[::-1]


def localizar_anclas_y_columnas(cajas, img_w, img_h):
    """Encuentra las coordenadas Y de las preguntas 1..30 y los límites horizontales."""
    candidatas = [c for c in cajas if c["num"] is not None]
    if not candidatas:
        return 0, img_w, img_w, []

    xs = sorted(c["x1"] for c in candidatas)
    x_margen = xs[len(xs) // 2]
    tol_x = max(15, img_w * 0.012)   # los números de pregunta están perfectamente alineados

    anclas_raw = [c for c in candidatas if abs(c["x1"] - x_margen) <= tol_x]
    anclas_raw.sort(key=lambda c: c["y1"])

    anclas = [(c["num"], int(c["y1"])) for c in _cadena_creciente(anclas_raw)]

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
        if y_rel > 45 and PATRON_UI_CORTE.match(c["txt"].strip()):
            corte_y = min(corte_y, max(45, y_rel - 8))

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


def detectar_miniaturas(img_bgr, x_min_frac=0.45):
    """Localiza TODAS las miniaturas de la página por su contorno (no por cuánto blanco tengan).

    Las miniaturas de Todotest tienen un tamaño casi fijo (~179x137 px en capturas de 1233 px de ancho) y
    un marco gris de 1 px, así que se detectan como contornos externos de ese tamaño en la mitad derecha.
    Las barras verdes de respuesta (muy anchas y bajas) y los textos (glifos pequeños) quedan fuera por tamaño.
    Antes se descartaba cualquier recorte con >72 % de píxeles blancos, lo que eliminaba señales y
    esquemas con fondo blanco (p. ej. P1, P5, P27, P28 de test70 y P2, P8 de test81).
    """
    h, w = img_bgr.shape[:2]
    esc = w / ANCHO_REF
    x0 = int(w * x_min_frac)
    gris = cv2.cvtColor(img_bgr[:, x0:], cv2.COLOR_BGR2GRAY)
    mascara = (gris < 243).astype(np.uint8) * 255
    mascara = cv2.dilate(mascara, np.ones((3, 3), np.uint8))
    contornos, _ = cv2.findContours(mascara, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    minis = []
    for c in contornos:
        x, y, bw, bh = cv2.boundingRect(c)
        if (90 * esc <= bw <= 330 * esc and 60 * esc <= bh <= 330 * esc
                and 0.6 <= bw / bh <= 2.6):
            minis.append((x + x0, y, bw, bh))
    return sorted(minis, key=lambda b: b[1])


def asignar_miniaturas(anclas, minis):
    """Asocia cada miniatura a la pregunta cuya ancla queda justo por encima (con 40 px de margen)."""
    asignadas = {}
    for (x, y, bw, bh) in minis:
        idx_elegido = None
        for idx, (_num, y_ancla) in enumerate(anclas):
            if y_ancla - 40 <= y:
                idx_elegido = idx
            else:
                break
        if idx_elegido is None:
            continue
        if y - anclas[idx_elegido][1] > 90:
            continue   # demasiado lejos: su pregunta no se localizó (no se la damos a la anterior)
        asignadas.setdefault(idx_elegido, (x, y, bw, bh))
    return asignadas


def guardar_miniatura(img_bgr, caja, nombre_archivo):
    x, y, bw, bh = caja
    h, w = img_bgr.shape[:2]
    pad = 2
    recorte = img_bgr[max(0, y - pad):min(h, y + bh + pad), max(0, x - pad):min(w, x + bw + pad)]
    ruta_salida = os.path.join(CARPETA_IMG, nombre_archivo)
    cv2.imwrite(ruta_salida, recorte, [cv2.IMWRITE_JPEG_QUALITY, 92])
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
    cajas_txt = ordenar_en_lineas(cajas_txt)

    enunciado_partes = []
    opciones = []
    scores_verde = []
    opcion_actual = None
    score_actual = 0
    ultima_letra = ""

    def total_opciones_iniciadas():
        return len(opciones) + (1 if opcion_actual is not None else 0)

    for c in cajas_txt:
        txt = c["txt"].strip()
        if not txt or PATRON_UI_CORTE.match(txt):
            continue

        if not enunciado_partes and opcion_actual is None:
            if PATRON_NUM_SOLO.match(txt):
                continue
            m_num = PATRON_NUM_CON_PUNTO.match(txt) or PATRON_NUM_CON_ESPACIO.match(txt)
            if m_num and 1 <= int(m_num.group(1)) <= MAX_PREGUNTAS:
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

    enunciado = restaurar_signos_interrogacion(" ".join(enunciado_partes).strip())
    if not enunciado or len(opciones) < 2:
        return None

    opciones = opciones[:3]
    scores_verde = scores_verde[:3]

    # Si no se ve ninguna marca verde (p. ej. captura SIN corregir) NO es que la correcta sea la "a":
    # se conserva correcta=0 para no romper la plantilla, pero se avisa con correcta_detectada=False.
    correcta_detectada = bool(scores_verde) and max(scores_verde) > UMBRAL_VERDE
    correcta_idx = int(np.argmax(scores_verde)) if correcta_detectada else 0

    return {
        "texto": enunciado,
        "opciones": opciones,
        "correcta": correcta_idx,
        "correcta_detectada": correcta_detectada,
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


def rutas_json_test(num_int):
    """Rutas posibles del JSON de un test: 'test_070.json' y, por si acaso, 'test_70.json'."""
    return [os.path.join(CARPETA_DATA, f"test_{nombre}.json")
            for nombre in dict.fromkeys((f"{num_int:03d}", str(num_int)))]


def json_verificado(num_int):
    """True si algún JSON existente del test trae "respuestas_verificadas": true (revisado/rellenado a mano o por IA)."""
    for ruta in rutas_json_test(num_int):
        try:
            with open(ruta, "r", encoding="utf-8") as f:
                if json.load(f).get("respuestas_verificadas") is True:
                    return True
        except (OSError, ValueError, AttributeError):
            continue
    return False


def marcar_verificados(seleccion):
    """Pone "respuestas_verificadas": true en los JSON indicados (lista de nº de test, o ['todos'])."""
    if [x.lower() for x in seleccion] == ["todos"]:
        rutas = sorted(glob.glob(os.path.join(CARPETA_DATA, "test_*.json")))
    else:
        rutas = []
        for x in seleccion:
            if not x.isdigit():
                print(f"[AVISO] '{x}' no es un número de test ni 'todos'.")
                continue
            existentes = [r for r in rutas_json_test(int(x)) if os.path.isfile(r)]
            if existentes:
                rutas.append(existentes[0])
            else:
                print(f"[AVISO] No existe JSON para el test {x}.")

    for ruta in rutas:
        with open(ruta, "r", encoding="utf-8") as f:
            data = json.load(f)
        sin_correcta = [i + 1 for i, p in enumerate(data.get("preguntas", [])) if not isinstance(p.get("correcta"), int)]
        if sin_correcta:
            print(f"  [AVISO] {os.path.basename(ruta)}: preguntas sin 'correcta' {sin_correcta}; no se marca.")
            continue
        data["respuestas_verificadas"] = True
        with open(ruta, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"  -> {os.path.basename(ruta)} marcado como verificado.")


def procesar_imagen_test(ruta_img, ocr_engine, debug=False, forzar=False):
    nombre_base = os.path.splitext(os.path.basename(ruta_img))[0]
    m_num = re.search(r"(\d+)", nombre_base)
    if not m_num:
        print(f"[AVISO] No se encontró número de test en '{ruta_img}'.")
        return

    num_int = int(m_num.group(1))
    num_str = f"{num_int:03d}"

    if not forzar and json_verificado(num_int):
        print(f"Test {num_str}: respuestas verificadas en data/; se omite para no sobrescribirlas (--forzar para regenerar).")
        return

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

    nums_detectados = {n for n, _ in anclas}
    faltan = [n for n in range(1, max(nums_detectados) + 1) if n not in nums_detectados]
    if faltan or max(nums_detectados) < MAX_PREGUNTAS:
        faltan += list(range(max(nums_detectados) + 1, MAX_PREGUNTAS + 1))
        print(f"  [AVISO] No se localizó el número de las preguntas: {faltan} (se perderán; usa --debug)")

    minis = detectar_miniaturas(img)
    minis_por_pregunta = asignar_miniaturas(anclas, minis)
    if debug:
        print(f"  [DEBUG] Miniaturas detectadas: {len(minis)} -> preguntas "
              f"{sorted(anclas[i][0] for i in minis_por_pregunta)}")

    preguntas = []
    descartadas = []
    sin_marca = []
    huecos = [b[1] - a[1] for a, b in zip(anclas, anclas[1:])]
    altura_estimada = int(sorted(huecos)[len(huecos) // 2]) if huecos else int(w * 0.25)

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
            descartadas.append(num_preg)
            if debug:
                print(f"  [DEBUG] Pregunta {num_preg} descartada. Cajas: {[c['txt'] for c in cajas_bloque]}")
            continue

        if not datos_preg.get("correcta_detectada", True):
            sin_marca.append(num_preg)

        if idx in minis_por_pregunta:
            nombre_miniatura = f"test_{num_str}_p{num_preg:02d}.jpg"
            datos_preg["imagen"] = guardar_miniatura(img, minis_por_pregunta[idx], nombre_miniatura)

        preguntas.append(datos_preg)

    if descartadas:
        print(f"  [AVISO] Preguntas descartadas por no leerse bien: {descartadas}")
    if preguntas and len(sin_marca) == len(preguntas):
        # Captura SIN corregir: no hay ninguna marca verde. Se quita "correcta" para que nadie (ni una IA
        # que lea el JSON después) tome el 0 por una respuesta real.
        for p in preguntas:
            p.pop("correcta", None)
            p.pop("correcta_detectada", None)
        print("  [INFO] Captura sin corregir: se omite 'correcta' en el JSON (no hay respuestas que leer).")
    elif sin_marca:
        print(f"  [AVISO] Sin marca verde en preguntas {sin_marca} -> 'correcta' no fiable ahí")

    # "respuestas_verificadas": false -> el script puede regenerar el JSON. Cuando alguien (o una IA) revise/rellene
    # las "correcta", debe ponerlo a true: el script dejará de sobrescribir ese test.
    ruta_json = os.path.join(CARPETA_DATA, f"test_{num_str}.json")
    with open(ruta_json, "w", encoding="utf-8") as f:
        json.dump({"test_id": num_int, "respuestas_verificadas": False, "preguntas": preguntas},
                  f, ensure_ascii=False, indent=2)

    n_img = sum(1 for p in preguntas if "imagen" in p)
    print(f"  -> OK: {len(preguntas)} preguntas extraídas ({n_img} con imagen) -> data/test_{num_str}.json")


def seleccionar_imagenes(imagenes):
    """Evita que 'test70.png' y 'test70_corregido.png' se pisen (ambas generan test_070.*).

    Si existe la versión corregida (la que trae las respuestas marcadas) se usa ésa y se omite la otra.
    """
    por_test = {}
    for ruta in imagenes:
        m = re.search(r"(\d+)", os.path.splitext(os.path.basename(ruta))[0])
        clave = int(m.group(1)) if m else ruta
        por_test.setdefault(clave, []).append(ruta)

    elegidas = []
    for clave, rutas in por_test.items():
        corregidas = [r for r in rutas if "corregid" in os.path.basename(r).lower()]
        if corregidas and len(rutas) > len(corregidas):
            omitidas = [os.path.basename(r) for r in rutas if r not in corregidas]
            print(f"[INFO] Test {clave}: se usa la versión corregida; se omite {omitidas}")
            elegidas.extend(corregidas)
        else:
            elegidas.extend(rutas)
    return sorted(elegidas)


def parsear_argumentos():
    parser = argparse.ArgumentParser(
        prog="procesar_capturas.py",
        description="Extrae preguntas, imágenes y respuestas correctas desde capturas largas de Todotest.",
        epilog=(
            "Ejemplos de uso:\n"
            "  python procesar_capturas.py                                    Procesa capturas_largas/capturas/\n"
            "  python procesar_capturas.py -i capturas_largas/capturas/test70.png\n"
            "  python procesar_capturas.py -i capturas_largas/capturas/test70.png --debug\n"
            "  python procesar_capturas.py --marcar-verificados 70 81        Protege esos JSON (no se sobrescriben)\n"
            "  python procesar_capturas.py --marcar-verificados todos\n"
            "  python procesar_capturas.py -i capturas_largas/capturas/test70.png --forzar   Regenera aunque esté verificado\n"
            "\n"
            "Genera data/test_XXX.json e img/test_XXX_pYY.jpg, que test.html consume directamente."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("-i", "--imagen", metavar="RUTA", help="Procesa una única imagen.")
    parser.add_argument("-c", "--carpeta", metavar="DIR", default=CARPETA_CAPTURAS_DEFAULT, help="Carpeta de capturas.")
    parser.add_argument("-f", "--forzar", action="store_true",
                        help='Regenera el JSON aunque tenga "respuestas_verificadas": true.')
    parser.add_argument("--marcar-verificados", nargs="+", metavar="N",
                        help='Pone "respuestas_verificadas": true en los tests indicados (nº de test o "todos") y sale.')
    parser.add_argument("-d", "--debug", action="store_true", help="Muestra trazas de diagnóstico del OCR y coordenadas.")
    return parser.parse_args()


if __name__ == "__main__":
    args = parsear_argumentos()

    if args.marcar_verificados:
        marcar_verificados(args.marcar_verificados)
        raise SystemExit(0)

    os.makedirs(CARPETA_IMG, exist_ok=True)
    os.makedirs(CARPETA_DATA, exist_ok=True)

    ocr = RapidOCR()

    if args.imagen:
        if not os.path.isfile(args.imagen):
            print(f"[ERROR] No existe el archivo: {args.imagen}")
        else:
            procesar_imagen_test(args.imagen, ocr, debug=args.debug, forzar=args.forzar)
    else:
        if not os.path.isdir(args.carpeta):
            print(f"[ERROR] No existe la carpeta '{args.carpeta}'.")
        else:
            archivos = sorted(glob.glob(os.path.join(args.carpeta, "*.*")))
            imagenes = [f for f in archivos if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
            if not imagenes:
                print(f"No se encontraron imágenes en '{args.carpeta}'.")
            else:
                for archivo in seleccionar_imagenes(imagenes):
                    procesar_imagen_test(archivo, ocr, debug=args.debug, forzar=args.forzar)
