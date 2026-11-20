"""Vigila la página de citas de alta de matrícula del Consulado de España en Buenos Aires.

Avisa por Telegram cuando:
  * el cartel "no hay citas disponibles" desaparece o queda oculto,
  * aparece un formulario, campo, captcha o calendario,
  * la página cambia de cualquier otra forma (aviso único, para que alguien la mire).
Avisa solo al administrador (primer chat id) cuando:
  * el bot no puede leer la página (y cuando se recupera),
  * pasó una semana (mensaje de "sigo vivo").

Variables de entorno:
  TELEGRAM_TOKEN     token del bot
  TELEGRAM_CHAT_IDS  chat ids separados por coma; el primero es el administrador
  FORCE_ALERT        "true" para mandar un aviso de prueba
"""
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser

URL = "https://www.cgeonline.com.ar/tramites/citas/varios/cita-varios.html?t=4"
RUTA_ESPERADA = "cita-varios.html"  # si nos redirigen a otro lado, es un error
NO_CITAS = "no hay citas disponibles"
MARCADOR = "matricula"  # debe aparecer siempre en una página bien cargada
ESTADO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")
RECORDATORIO_FALLO = 6 * 3600  # segundos entre recordatorios mientras falla

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
CAMPOS = {"form", "select", "input", "textarea", "iframe"}
SOSPECHOSOS = ("captcha", "calend", "datepick")  # en class o id
CLASES_OCULTAS = {"d-none", "hidden", "invisible"}
RE_OCULTO = re.compile(r"display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])")


def norm(s):
    """Minúsculas, sin tildes, espacios colapsados."""
    s = unicodedata.normalize("NFD", s.replace("\xa0", " ").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", s).strip()


class Pagina(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.pila = []  # (tag, oculto)
        self.visible, self.oculto = [], []
        self.hrefs, self.srcs, self.scripts, self.campos = set(), set(), [], []
        self._script = None
        self._style = False

    @staticmethod
    def _es_oculto(a):
        clases = set(a.get("class", "").lower().split())
        return (
            "hidden" in a
            or a.get("aria-hidden", "").lower() == "true"
            or bool(RE_OCULTO.search(a.get("style", "").lower()))
            or bool(clases & CLASES_OCULTAS)
        )

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        padre = self.pila[-1][1] if self.pila else False
        if tag in CAMPOS and not (tag == "input" and a.get("type", "").lower() == "hidden"):
            self.campos.append(tag)
        for v in (a.get("class", ""), a.get("id", "")):
            if any(s in v.lower() for s in SOSPECHOSOS):
                self.campos.append("attr:" + v.lower())
        href = a.get("href")
        if href and not href.startswith("/cdn-cgi/") and not href.startswith("#"):
            self.hrefs.add(href)
        if tag == "script":
            if a.get("src"):
                self.srcs.add(a["src"])
            else:
                self._script = []
        if tag == "style":
            self._style = True
        if tag not in VOID:
            self.pila.append((tag, padre or self._es_oculto(a)))

    def handle_endtag(self, tag):
        if tag == "script" and self._script is not None:
            self.scripts.append("".join(self._script))
            self._script = None
        if tag == "style":
            self._style = False
        for i in range(len(self.pila) - 1, -1, -1):
            if self.pila[i][0] == tag:
                del self.pila[i:]
                break

    def handle_data(self, data):
        if self._script is not None:
            self._script.append(data)
        elif not self._style:
            oculto = self.pila[-1][1] if self.pila else False
            (self.oculto if oculto else self.visible).append(data)


def analizar(html):
    p = Pagina()
    p.feed(html)
    p.close()
    visible, oculto = norm(" ".join(p.visible)), norm(" ".join(p.oculto))
    campos = sorted(set(p.campos))
    huella = hashlib.sha256(
        json.dumps(
            [visible, oculto, sorted(p.hrefs), sorted(p.srcs), [norm(s) for s in p.scripts], campos],
            ensure_ascii=False,
        ).encode()
    ).hexdigest()
    return {
        "marcador": MARCADOR in visible or MARCADOR in oculto,
        "cartel_visible": NO_CITAS in visible,
        "campos": campos,
        "huella": huella,
    }


def clasificar(r, baseline):
    """CITAS: hay que avisar siempre. CAMBIO: aviso único. NADA: todo igual."""
    if not r["cartel_visible"] or r["campos"]:
        return "CITAS"
    if baseline is not None and r["huella"] != baseline:
        return "CAMBIO"
    return "NADA"


def descargar():
    ultimo = None
    for i in range(3):
        try:
            req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                if RUTA_ESPERADA not in resp.geturl():
                    raise RuntimeError(f"Redirigida a {resp.geturl()}")
                return resp.read().decode("utf-8", "replace")
        except Exception as e:
            ultimo = e
            time.sleep(5 * (i + 1))
    raise ultimo


def enviar(texto, chats):
    """Devuelve True solo si llegó a todos los destinatarios."""
    token = os.environ["TELEGRAM_TOKEN"].strip().lstrip("﻿")
    todo_ok = True
    for chat in chats:
        data = urllib.parse.urlencode({"chat_id": chat, "text": texto}).encode()
        for intento in range(3):
            try:
                urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data, timeout=30)
                break
            except Exception as e:
                print(f"Falló el envío a {chat} (intento {intento + 1}): {e}")
                time.sleep(3)
        else:
            todo_ok = False
    return todo_ok


def cargar_estado():
    try:
        with open(ESTADO, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def main():
    chats = [c.strip().lstrip("﻿") for c in os.environ["TELEGRAM_CHAT_IDS"].split(",") if c.strip()]
    admin = chats[:1]
    estado = cargar_estado()
    original = json.dumps(estado, sort_keys=True)
    codigo = 0

    try:
        html = descargar()
        r = analizar(html)
        if not r["marcador"]:
            raise RuntimeError("La página cargó pero ya no aparece 'matrícula': cambió o es un bloqueo")
    except Exception as e:
        print(f"ERROR leyendo la página: {e}")
        ahora = time.time()
        if estado.get("estado") != "fallando":
            if enviar(f"⚠️ El bot no pudo leer la página del consulado: {e}", admin):
                estado["estado"], estado["aviso_fallo"] = "fallando", ahora
            codigo = 1  # GitHub también avisa por mail
        elif ahora - estado.get("aviso_fallo", 0) > RECORDATORIO_FALLO:
            if enviar(f"⚠️ Sigue fallando la lectura de la página del consulado: {e}", admin):
                estado["aviso_fallo"] = ahora
        guardar(estado, original)
        return codigo

    aviso = "🚨 Consulado de España: puede haber citas de alta de matrícula. Entrá ya: " + URL

    if os.environ.get("FORCE_ALERT") == "true":
        return 0 if enviar(aviso + " (prueba)", chats) else 1

    if estado.get("estado") == "fallando":
        if enviar("✅ El bot volvió a leer la página del consulado.", admin):
            estado["estado"] = "ok"

    veredicto = clasificar(r, estado.get("baseline"))
    print(f"Veredicto: {veredicto} (cartel visible={r['cartel_visible']}, campos={r['campos']})")

    if veredicto == "CITAS":
        if not enviar(aviso, chats):
            codigo = 1
    elif veredicto == "CAMBIO":
        msg = "👀 La página de citas del consulado cambió (puede no haber citas). Revisenla: " + URL
        if enviar(msg, chats):
            estado["baseline"] = r["huella"]
        else:
            codigo = 1
    elif "baseline" not in estado:
        estado["baseline"] = r["huella"]  # primera corrida: se toma como referencia

    semana = datetime.now(timezone.utc).strftime("%G-W%V")
    if estado.get("latido") != semana and veredicto == "NADA":
        if enviar("💚 El bot del consulado sigue funcionando. Todavía no hay citas.", admin):
            estado["latido"] = semana

    guardar(estado, original)
    return codigo


def guardar(estado, original):
    if json.dumps(estado, sort_keys=True) != original:
        with open(ESTADO, "w", encoding="utf-8", newline="\n") as f:
            json.dump(estado, f, indent=2, sort_keys=True)
            f.write("\n")


if __name__ == "__main__":
    sys.exit(main())
