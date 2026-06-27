/**
 * ACOPIO VE — Capa de datos
 *
 * Estrategia de resiliencia:
 *  1. REST API (fetch) como fuente primaria — funciona con HTTP simple, sin WebSocket
 *  2. Firebase SDK real-time como mejora opcional — actualiza en vivo si la conexión lo permite
 *  3. Caché local (localStorage) como último recurso offline
 */

const API = (() => {
  const BASE = FIREBASE_CONFIG.databaseURL;
  const CACHE_KEY = "acopio_ve_centros";
  let db = null;
  let sdkListo = false;

  /* ── Inicializar Firebase SDK (opcional, para real-time) ── */
  function initSDK() {
    try {
      const app = firebase.initializeApp(FIREBASE_CONFIG);
      db = app.database();
      sdkListo = true;
    } catch (e) {
      console.warn("[API] Firebase SDK no disponible:", e.message);
    }
  }

  /* ══════════════════════════════════════════
     REST API — Fuente primaria (HTTP, sin WebSocket)
     ══════════════════════════════════════════ */

  /**
   * GET /centros — carga todos los centros vía REST.
   * Timeout configurable, fallback a caché local.
   */
  async function cargarCentros(timeoutMs = 10000) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      const res = await fetch(`${BASE}/centros.json`, {
        signal: ctrl.signal,
        cache: "no-store"
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const val = await res.json();
      const centros = val
        ? Object.entries(val).map(([id, c]) => ({ id, ...c }))
        : [];

      // Guardar en caché
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), centros }));
      } catch (_) {}

      return centros;

    } catch (err) {
      if (err.name === "AbortError") throw new Error("Tiempo de espera agotado.");
      throw err;
    }
  }

  /** Cargar centros desde caché local (offline) */
  function cargarCentrosCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const { ts, centros } = JSON.parse(raw);
      return { centros, edadMinutos: Math.floor((Date.now() - ts) / 60000) };
    } catch (_) {
      return null;
    }
  }

  /**
   * POST /centros — crear centro vía REST.
   */
  async function crearCentro(data) {
    validar(data);
    const centro = normalizar(data, false);

    const res = await fetch(`${BASE}/centros.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(centro)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Error del servidor: ${res.status} — ${body}`);
    }

    const { name: id } = await res.json();
    invalidarCache();
    return { id, centro };
  }

  /**
   * PATCH /centros/:id — actualizar centro vía REST.
   */
  async function actualizarCentro(id, data) {
    const updates = { actualizadoEn: Date.now() };
    const permitidos = ["capacidad","insumos","contacto","responsable","horario","notas",
                        "nombre","estado","municipio","direccion","lat","lng"];
    for (const k of permitidos) {
      if (data[k] !== undefined && data[k] !== "") updates[k] = data[k];
    }

    const res = await fetch(`${BASE}/centros/${id}.json`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Error del servidor: ${res.status} — ${body}`);
    }

    invalidarCache();
  }

  /* ══════════════════════════════════════════
     REAL-TIME — mejora opcional vía Firebase SDK
     ══════════════════════════════════════════ */

  /**
   * Escuchar cambios en tiempo real.
   * @returns {Function|null}  función para desuscribirse, o null si SDK no disponible
   */
  function escucharCambios(callback) {
    if (!sdkListo || !db) return null;

    const ref = db.ref("centros");
    ref.on("value",
      snap => {
        const val = snap.val() || {};
        const centros = Object.entries(val).map(([id, c]) => ({ id, ...c }));
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), centros }));
        } catch (_) {}
        callback(centros);
      },
      err => {
        console.warn("[API] Real-time error:", err.message);
        // No propagamos el error — el REST polling cubre esto
      }
    );

    return () => { try { ref.off("value"); } catch (_) {} };
  }

  /* ── Utilidades internas ── */

  function invalidarCache() {
    try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
  }

  function validar(data) {
    const req = ["nombre","estado","municipio","direccion","lat","lng","capacidad","insumos"];
    for (const campo of req) {
      if (!data[campo] && data[campo] !== 0)
        throw new Error(`Campo requerido: ${campo}`);
    }
    if (!Array.isArray(data.insumos) || data.insumos.length === 0)
      throw new Error("Selecciona al menos un tipo de insumo.");
    const lat = parseFloat(data.lat);
    const lng = parseFloat(data.lng);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180)
      throw new Error("Coordenadas geográficas inválidas.");
  }

  function normalizar(data, esActualizacion) {
    const ahora = Date.now();
    const obj = {
      nombre:       String(data.nombre).trim(),
      estado:       String(data.estado).trim(),
      municipio:    String(data.municipio).trim(),
      direccion:    String(data.direccion).trim(),
      lat:          parseFloat(data.lat),
      lng:          parseFloat(data.lng),
      capacidad:    data.capacidad,
      insumos:      data.insumos,
      contacto:     String(data.contacto   || "").trim(),
      responsable:  String(data.responsable || "").trim(),
      horario:      String(data.horario    || "").trim(),
      notas:        String(data.notas      || "").trim(),
      actualizadoEn: ahora
    };
    if (!esActualizacion) obj.creadoEn = ahora;
    return obj;
  }

  return {
    initSDK,
    cargarCentros,
    cargarCentrosCache,
    crearCentro,
    actualizarCentro,
    escucharCambios
  };
})();
