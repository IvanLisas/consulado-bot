"""Tests sin red: python -m unittest test_check -v"""
import unittest

import check

BASE = """<html><head><title>Solicitar cita para alta en matrícula</title>
<script src="/scripts/jquery.js"></script></head><body>
<nav><button class="navbar-toggler">menú</button></nav>
{cuerpo}
</body></html>"""

SIN_CITAS = '<p>En este momento no hay citas disponibles. Los turnos serán habilitados próximamente.</p>'


def pag(cuerpo):
    return check.analizar(BASE.format(cuerpo=cuerpo))


class Tests(unittest.TestCase):
    def veredicto(self, cuerpo, ref=SIN_CITAS):
        base = pag(ref)["huella"]
        return check.clasificar(pag(cuerpo), base)

    def test_sin_citas_es_nada(self):
        self.assertEqual(self.veredicto(SIN_CITAS), "NADA")

    def test_espacios_y_entidades_no_cambian_nada(self):
        self.assertEqual(self.veredicto("<p>En este momento  NO hay&nbsp;citas\n disponibles.  Los turnos serán habilitados próximamente.</p>"), "NADA")

    def test_cartel_borrado(self):
        self.assertEqual(self.veredicto("<p>Elija fecha</p>"), "CITAS")

    def test_cartel_oculto_style(self):
        self.assertEqual(self.veredicto(f'<div style="display: none">{SIN_CITAS}</div><p>Elija fecha</p>'), "CITAS")

    def test_cartel_oculto_clase(self):
        self.assertEqual(self.veredicto(f'<div class="alert d-none">{SIN_CITAS}</div>'), "CITAS")

    def test_cartel_oculto_atributo(self):
        self.assertEqual(self.veredicto(f"<div hidden>{SIN_CITAS}</div>"), "CITAS")

    def test_cartel_oculto_en_padre(self):
        self.assertEqual(self.veredicto(f'<div style="visibility:hidden"><section><p>{SIN_CITAS}</p></section></div>'), "CITAS")

    def test_cartel_sigue_pero_aparece_formulario(self):
        self.assertEqual(self.veredicto(SIN_CITAS + "<form><select><option>1</option></select></form>"), "CITAS")

    def test_cartel_sigue_pero_aparece_input(self):
        self.assertEqual(self.veredicto(SIN_CITAS + '<input type="text">'), "CITAS")

    def test_captcha_o_calendario(self):
        self.assertEqual(self.veredicto(SIN_CITAS + '<div class="g-recaptcha"></div>'), "CITAS")
        self.assertEqual(self.veredicto(SIN_CITAS + '<div id="calendario"></div>'), "CITAS")

    def test_cartel_cambia_de_texto(self):
        self.assertEqual(self.veredicto("<p>Por el momento no existen turnos.</p>"), "CITAS")

    def test_cambio_menor_es_aviso_unico(self):
        self.assertEqual(self.veredicto(SIN_CITAS + "<p>Nuevo aviso de feriado.</p>"), "CAMBIO")

    def test_link_nuevo_es_cambio(self):
        self.assertEqual(self.veredicto(SIN_CITAS + '<a href="/tramites/citas/varios/solicitud.html">Solicitar</a>'), "CAMBIO")

    def test_script_nuevo_es_cambio(self):
        self.assertEqual(self.veredicto(SIN_CITAS + "<script>cargarTurnos();</script>"), "CAMBIO")

    def test_primera_corrida_sin_baseline(self):
        self.assertEqual(check.clasificar(pag(SIN_CITAS), None), "NADA")

    def test_marcador(self):
        self.assertTrue(pag(SIN_CITAS)["marcador"])
        self.assertFalse(check.analizar("<html><body>Access denied</body></html>")["marcador"])

    def test_boton_de_menu_no_es_campo(self):
        self.assertEqual(pag(SIN_CITAS)["campos"], [])


if __name__ == "__main__":
    unittest.main()
