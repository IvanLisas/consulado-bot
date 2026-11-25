// Vigila la página de citas de alta de matrícula del Consulado de España en Buenos Aires.
// Corre en Cloudflare Workers con un cron de 1 minuto. Misma lógica que check.py.
//
// Secretos: TELEGRAM_TOKEN, TELEGRAM_CHAT_IDS (el primero es el administrador), ADMIN_KEY (opcional, para /status y /test)
// KV: STATE

const URL_CITAS = "https://www.cgeonline.com.ar/tramites/citas/varios/cita-varios.html?t=4";
const RUTA_ESPERADA = "cita-varios.html";
const NO_CITAS = "no hay citas disponibles";
const MARCADOR = "matricula";
const REPETIR_CITAS_MS = 5 * 60 * 1000; // mientras haya citas, repetir el aviso cada 5 min
const RECORDATORIO_FALLO_MS = 6 * 3600 * 1000;
const FALLOS_PARA_AVISAR = 3; // corridas seguidas fallando antes de avisar (evita falsas alarmas)

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const CAMPOS = new Set(["form", "select", "input", "textarea", "iframe"]);
const SOSPECHOSOS = ["captcha", "calend", "datepick"];
const CLASES_OCULTAS = new Set(["d-none", "hidden", "invisible"]);
const RE_OCULTO = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])/;

const ENTIDADES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", iexcl: "¡", iquest: "¿", ordm: "º", ordf: "ª",
};

function decodificar(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTIDADES[e] ?? m;
  });
}

export function norm(s) {
  return s.replace(/ /g, " ").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim();
}

function atributos(texto) {
  const a = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(texto))) a[m[1].toLowerCase()] = decodificar(m[2] ?? m[3] ?? m[4] ?? "");
  return a;
}

function esOculto(a) {
  const clases = (a.class ?? "").toLowerCase().split(/\s+/);
  return (
    "hidden" in a ||
    (a["aria-hidden"] ?? "").toLowerCase() === "true" ||
    RE_OCULTO.test((a.style ?? "").toLowerCase()) ||
    clases.some((c) => CLASES_OCULTAS.has(c))
  );
}

async function sha256(texto) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function analizar(html) {
  const pila = []; // [tag, oculto]
  const visible = [], oculto = [], scripts = [], campos = [];
  const hrefs = new Set(), srcs = new Set();
  const minusculas = html.toLowerCase();
  const re = /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let pos = 0, m;

  const texto = (t) => {
    if (!t) return;
    const o = pila.length ? pila[pila.length - 1][1] : false;
    (o ? oculto : visible).push(decodificar(t));
  };

  while ((m = re.exec(html))) {
    texto(html.slice(pos, m.index));
    pos = re.lastIndex;
    if (!m[2]) continue; // comentario o doctype
    const tag = m[2].toLowerCase();

    if (m[1] === "/") {
      for (let i = pila.length - 1; i >= 0; i--) {
        if (pila[i][0] === tag) { pila.length = i; break; }
      }
      continue;
    }

    const a = atributos(m[3]);
    const padre = pila.length ? pila[pila.length - 1][1] : false;
    if (CAMPOS.has(tag) && !(tag === "input" && (a.type ?? "").toLowerCase() === "hidden")) campos.push(tag);
    for (const v of [a.class ?? "", a.id ?? ""]) {
      if (SOSPECHOSOS.some((s) => v.toLowerCase().includes(s))) campos.push("attr:" + v.toLowerCase());
    }
    if (a.href && !a.href.startsWith("/cdn-cgi/") && !a.href.startsWith("#")) hrefs.add(a.href);

    if (tag === "script" || tag === "style") {
      if (tag === "script" && a.src) srcs.add(a.src);
      const fin = minusculas.indexOf("</" + tag, pos);
      const contenido = html.slice(pos, fin < 0 ? html.length : fin);
      if (tag === "script" && !a.src) scripts.push(contenido);
      pos = re.lastIndex = fin < 0 ? html.length : fin;
    }
    if (!VOID.has(tag)) pila.push([tag, padre || esOculto(a)]);
  }
  texto(html.slice(pos));

  const v = norm(visible.join(" ")), o = norm(oculto.join(" "));
  const camposU = [...new Set(campos)].sort();
  const huella = await sha256(
    JSON.stringify([v, o, [...hrefs].sort(), [...srcs].sort(), scripts.map(norm), camposU]),
  );
  return { marcador: v.includes(MARCADOR) || o.includes(MARCADOR), cartel_visible: v.includes(NO_CITAS), campos: camposU, huella };
}

export function clasificar(r, baseline) {
  if (!r.cartel_visible || r.campos.length) return "CITAS";
  if (baseline != null && r.huella !== baseline) return "CAMBIO";
  return "NADA";
}

async function descargar() {
  let ultimo;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(URL_CITAS, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.url.includes(RUTA_ESPERADA)) throw new Error(`Redirigida a ${res.url}`);
      return await res.text();
    } catch (e) {
      ultimo = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw ultimo;
}

async function enviar(env, texto, chats) {
  const token = env.TELEGRAM_TOKEN.trim();
  let todoOk = true;
  for (const chat of chats) {
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text: texto }),
        });
        ok = res.ok;
        if (!ok) console.log(`Telegram respondió ${res.status}`);
      } catch (e) {
        console.log("Falló el envío:", String(e).replaceAll(token, "***"));
      }
      if (!ok) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ok) todoOk = false;
  }
  return todoOk;
}

function semanaISO(ms) {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const sem = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(sem).padStart(2, "0")}`;
}

export async function revisar(env, { forzar = false, ahora = Date.now() } = {}) {
  const chats = env.TELEGRAM_CHAT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  const admin = chats.slice(0, 1);
  const estado = JSON.parse((await env.STATE.get("estado")) || "{}");
  const original = JSON.stringify(estado);
  const guardar = async () => {
    if (JSON.stringify(estado) !== original) await env.STATE.put("estado", JSON.stringify(estado));
  };
  const aviso = "🚨 Consulado de España: puede haber citas de alta de matrícula. Entrá ya: " + URL_CITAS;

  let r;
  try {
    r = await analizar(await descargar());
    if (!r.marcador) throw new Error("La página cargó pero ya no aparece 'matrícula': cambió o es un bloqueo");
  } catch (e) {
    console.log("ERROR leyendo la página:", String(e));
    estado.fallos = Math.min((estado.fallos || 0) + 1, FALLOS_PARA_AVISAR);
    if (estado.fallos >= FALLOS_PARA_AVISAR) {
      if (estado.estado !== "fallando") {
        if (await enviar(env, `⚠️ El bot no pudo leer la página del consulado: ${e}`, admin)) {
          estado.estado = "fallando";
          estado.aviso_fallo = ahora;
        }
      } else if (ahora - (estado.aviso_fallo || 0) > RECORDATORIO_FALLO_MS) {
        if (await enviar(env, `⚠️ Sigue fallando la lectura de la página del consulado: ${e}`, admin)) estado.aviso_fallo = ahora;
      }
    }
    await guardar();
    return "FALLO";
  }

  if (forzar) return (await enviar(env, aviso + " (prueba)", chats)) ? "PRUEBA" : "ERROR_ENVIO";

  estado.fallos = 0;
  if (estado.estado === "fallando") {
    if (await enviar(env, "✅ El bot volvió a leer la página del consulado.", admin)) estado.estado = "ok";
  }

  const veredicto = clasificar(r, estado.baseline);
  console.log(`Veredicto: ${veredicto} (cartel visible=${r.cartel_visible}, campos=${JSON.stringify(r.campos)})`);

  if (veredicto === "CITAS") {
    if (estado.ultimo_citas == null || ahora - estado.ultimo_citas >= REPETIR_CITAS_MS) {
      if (await enviar(env, aviso, chats)) estado.ultimo_citas = ahora;
    }
  } else {
    delete estado.ultimo_citas; // si vuelven a abrir, el primer aviso sale al instante
    if (veredicto === "CAMBIO") {
      const msg = "👀 La página de citas del consulado cambió (puede no haber citas). Revisenla: " + URL_CITAS;
      if (await enviar(env, msg, chats)) estado.baseline = r.huella;
    } else if (estado.baseline == null) {
      estado.baseline = r.huella; // primera corrida: queda como referencia
    }
    const semana = semanaISO(ahora);
    if (veredicto === "NADA" && estado.latido !== semana) {
      if (await enviar(env, "💚 El bot del consulado sigue funcionando (revisa cada minuto). Todavía no hay citas.", admin)) {
        estado.latido = semana;
      }
    }
  }
  await guardar();
  return veredicto;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(revisar(env));
  },
  // /status y /test solo responden con ?key=ADMIN_KEY; sin clave, 404.
  async fetch(req, env) {
    const u = new URL(req.url);
    if (!env.ADMIN_KEY || u.searchParams.get("key") !== env.ADMIN_KEY) return new Response("Not found", { status: 404 });
    if (u.pathname === "/status") return new Response((await env.STATE.get("estado")) || "{}", { headers: { "content-type": "application/json" } });
    if (u.pathname === "/test") return new Response(await revisar(env, { forzar: true }));
    return new Response("Not found", { status: 404 });
  },
};
