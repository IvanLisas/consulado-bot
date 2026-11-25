// node --test worker/test
import test from "node:test";
import assert from "node:assert/strict";
import { analizar, clasificar, revisar } from "../src/index.js";

const BASE = (c) => `<html><head><title>Solicitar cita para alta en matrícula</title>
<script src="/scripts/jquery.js"></script></head><body><nav><button class="navbar-toggler">menú</button></nav>${c}</body></html>`;
const SIN = "<p>En este momento no hay citas disponibles. Los turnos serán habilitados próximamente.</p>";
const ver = async (cuerpo) => clasificar(await analizar(BASE(cuerpo)), (await analizar(BASE(SIN))).huella);

test("sin citas es NADA", async () => assert.equal(await ver(SIN), "NADA"));
test("espacios, mayúsculas y entidades no cambian nada", async () =>
  assert.equal(await ver("<p>En este momento  NO hay&nbsp;citas\n disponibles.  Los turnos serán habilitados próximamente.</p>"), "NADA"));
test("entidades con tildes", async () => {
  const r = await analizar("<html><title>matr&iacute;cula</title><p>no hay citas disponibles</p></html>");
  assert.ok(r.marcador && r.cartel_visible);
});
test("cartel borrado", async () => assert.equal(await ver("<p>Elija fecha</p>"), "CITAS"));
test("cartel oculto (style)", async () => assert.equal(await ver(`<div style="display: none">${SIN}</div><p>x</p>`), "CITAS"));
test("cartel oculto (clase)", async () => assert.equal(await ver(`<div class="alert d-none">${SIN}</div>`), "CITAS"));
test("cartel oculto (atributo)", async () => assert.equal(await ver(`<div hidden>${SIN}</div>`), "CITAS"));
test("cartel oculto en un padre", async () => assert.equal(await ver(`<div style="visibility:hidden"><section><p>${SIN}</p></section></div>`), "CITAS"));
test("aparece formulario", async () => assert.equal(await ver(SIN + "<form><select><option>1</option></select></form>"), "CITAS"));
test("aparece input", async () => assert.equal(await ver(SIN + '<input type="text">'), "CITAS"));
test("captcha o calendario", async () => {
  assert.equal(await ver(SIN + '<div class="g-recaptcha"></div>'), "CITAS");
  assert.equal(await ver(SIN + '<div id="calendario"></div>'), "CITAS");
});
test("cartel con otro texto", async () => assert.equal(await ver("<p>Por el momento no existen turnos.</p>"), "CITAS"));
test("cambio menor es CAMBIO", async () => assert.equal(await ver(SIN + "<p>Aviso de feriado.</p>"), "CAMBIO"));
test("link nuevo es CAMBIO", async () => assert.equal(await ver(SIN + '<a href="/solicitud.html">Solicitar</a>'), "CAMBIO"));
test("script nuevo es CAMBIO", async () => assert.equal(await ver(SIN + "<script>cargarTurnos();</script>"), "CAMBIO"));
test("primera corrida sin baseline", async () => assert.equal(clasificar(await analizar(BASE(SIN)), null), "NADA"));
test("marcador", async () => {
  assert.ok((await analizar(BASE(SIN))).marcador);
  assert.ok(!(await analizar("<html><body>Access denied</body></html>")).marcador);
});
test("botón de menú no es campo", async () => assert.deepEqual((await analizar(BASE(SIN))).campos, []));
test("comentarios y scripts con < no rompen el parser", async () => {
  const r = await analizar(BASE(SIN + "<!-- <form> --><script>if (a<b && c>d) {}</script>"));
  assert.deepEqual(r.campos, []);
  assert.ok(r.cartel_visible);
});

// ---- flujo completo con KV y fetch simulados ----
function entorno() {
  const kv = new Map();
  return {
    kv,
    env: {
      TELEGRAM_TOKEN: "tok",
      TELEGRAM_CHAT_IDS: "111,222",
      STATE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
    },
  };
}
function simular(html, enviados, { falla = false } = {}) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("telegram")) {
      const b = JSON.parse(opts.body);
      enviados.push([b.chat_id, b.text.slice(0, 12)]);
      return { ok: true, status: 200 };
    }
    if (falla) throw new Error("bloqueado");
    return { ok: true, status: 200, url: "https://x/cita-varios.html", text: async () => html };
  };
}
const MIN = 60_000;

test("flujo: referencia, citas con repetición cada 5 min, vuelta a normal", async () => {
  const { env } = entorno();
  const out = [];
  simular(BASE(SIN), out);
  assert.equal(await revisar(env, { ahora: 0 }), "NADA");
  assert.deepEqual(out.map((x) => x[0]), ["111"]); // "sigo vivo" solo al admin
  out.length = 0;

  simular(BASE("<p>Elija fecha</p>"), out);
  await revisar(env, { ahora: 1 * MIN });
  assert.deepEqual(out.map((x) => x[0]), ["111", "222"]); // primer aviso, a los dos
  out.length = 0;
  await revisar(env, { ahora: 2 * MIN });
  await revisar(env, { ahora: 5 * MIN });
  assert.equal(out.length, 0); // no repite antes de 5 min
  await revisar(env, { ahora: 6 * MIN });
  assert.equal(out.length, 2); // repite a los 5 min
});

test("flujo: fallo avisa solo al admin tras 3 corridas, recordatorio y recuperación", async () => {
  const { env } = entorno();
  const out = [];
  simular(BASE(SIN), out);
  await revisar(env, { ahora: 0 });
  out.length = 0;
  simular("", out, { falla: true });
  const orig = globalThis.setTimeout; globalThis.setTimeout = (f) => orig(f, 0);
  await revisar(env, { ahora: 1 * MIN });
  await revisar(env, { ahora: 2 * MIN });
  assert.equal(out.length, 0); // todavía no avisa
  await revisar(env, { ahora: 3 * MIN });
  assert.deepEqual(out.map((x) => x[0]), ["111"]);
  await revisar(env, { ahora: 4 * MIN });
  assert.equal(out.length, 1); // sin repetir
  await revisar(env, { ahora: 3 * MIN + 7 * 3600_000 });
  assert.equal(out.length, 2); // recordatorio
  simular(BASE(SIN), out);
  await revisar(env, { ahora: 3 * MIN + 7 * 3600_000 + MIN });
  assert.equal(out[2][1], "✅ El bot vol");
  globalThis.setTimeout = orig;
});

test("flujo: cambio menor avisa una sola vez", async () => {
  const { env } = entorno();
  const out = [];
  simular(BASE(SIN), out);
  await revisar(env, { ahora: 0 });
  out.length = 0;
  simular(BASE(SIN + "<p>Aviso de feriado.</p>"), out);
  await revisar(env, { ahora: MIN });
  assert.equal(out.length, 2);
  await revisar(env, { ahora: 2 * MIN });
  assert.equal(out.length, 2);
});
