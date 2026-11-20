"""Avisa por Telegram cuando la página de citas de alta de matrícula
deja de decir 'no hay citas disponibles'.

Variables de entorno:
  TELEGRAM_TOKEN     token del bot (de @BotFather)
  TELEGRAM_CHAT_IDS  chat ids separados por coma (ella y vos), ej: 123456789,987654321
"""
import os
import sys
import urllib.parse
import urllib.request

URL = "https://www.cgeonline.com.ar/tramites/citas/varios/cita-varios.html?t=4"
NO_CITAS = "no hay citas disponibles"
MARCADOR = "matrícula"  # texto que siempre debe estar en la página si cargó bien


def telegram(texto):
    token = os.environ["TELEGRAM_TOKEN"].strip().lstrip("\ufeff")
    fallos = 0
    for chat in os.environ["TELEGRAM_CHAT_IDS"].lstrip("\ufeff").split(","):
        data = urllib.parse.urlencode({"chat_id": chat.strip(), "text": texto}).encode()
        try:
            urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data, timeout=30)
        except Exception as e:
            print(f"Falló el envío a {chat}: {e}")
            fallos += 1
    if fallos:
        sys.exit(1)  # que GitHub avise por mail si no se pudo mandar


def main():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace").lower()

    if MARCADOR not in html:
        # Página rara (bloqueo, error, cambio de diseño): falla para que GitHub avise por mail
        print("Página inesperada, no se puede decidir")
        sys.exit(1)

    aviso = "🚨 Consulado de España: puede haber citas de alta de matrícula. Entrá ya: " + URL

    if os.environ.get("FORCE_ALERT") == "true":
        telegram(aviso + " (prueba)")
        return

    # Sin citas, la página no tiene formulario ni campos. Si aparecen, avisamos aunque
    # el texto "no hay citas" siga estando (por ejemplo, oculto).
    hay_formulario = any(t in html for t in ("<form", "<select", "<input"))

    if NO_CITAS in html and not hay_formulario:
        print("Sin citas todavía")
        return

    print("¡Posibles citas!")
    telegram(aviso)


if __name__ == "__main__":
    main()
