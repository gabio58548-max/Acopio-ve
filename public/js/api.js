/**
 * ACOPIO VE — Capa de datos
 *
 * Fuentes:
 *  1. ResponseGrid (lectura primaria) — 574+ centros Venezuela + diáspora
 *  2. Firebase RTDB (escritura + centros agregados por usuarios)
 *  3. Caché localStorage — fallback offline
 */

const API = (() => {
  const BASE      = FIREBASE_CONFIG.databaseURL;
  const CACHE_KEY = "acopio_ve_centros";

  /* ── ResponseGrid ── */
  const RG_BASE      = "https://api.responsegrid.app";
  const RG_EMERGENCY = "11111111-1111-4111-8111-111111111111";
  const CACHE_KEY_RG = "acopio_ve_rg";

  /* ── Mapeo ciudad → estado venezolano ── */
  const CITY_ESTADO = {
    "Caracas":               "Distrito Capital",
    "Barquisimeto":          "Lara",
    "Cabudare":              "Lara",
    "Quíbor":                "Lara",
    "Maracay":               "Aragua",
    "La Victoria":           "Aragua",
    "Turmero":               "Aragua",
    "Cagua":                 "Aragua",
    "Villa de Cura":         "Aragua",
    "Valencia":              "Carabobo",
    "San Diego":             "Carabobo",
    "Naguanagua":            "Carabobo",
    "Maracaibo":             "Zulia",
    "Ciudad Ojeda":          "Zulia",
    "Cabimas":               "Zulia",
    "Maturín":               "Monagas",
    "Mérida":                "Mérida",
    "Ejido":                 "Mérida",
    "El Vigía":              "Mérida",
    "Barcelona":             "Anzoátegui",
    "Puerto La Cruz":        "Anzoátegui",
    "Lechería":              "Anzoátegui",
    "El Tigre":              "Anzoátegui",
    "San Cristóbal":         "Táchira",
    "Táriba":                "Táchira",
    "Rubio":                 "Táchira",
    "Ciudad Bolívar":        "Bolívar",
    "Puerto Ordaz":          "Bolívar",
    "San Félix":             "Bolívar",
    "Upata":                 "Bolívar",
    "Coro":                  "Falcón",
    "Punto Fijo":            "Falcón",
    "Tucacas":               "Falcón",
    "San Juan de los Morros":"Guárico",
    "Valle de la Pascua":    "Guárico",
    "Calabozo":              "Guárico",
    "Altagracia de Orituco": "Guárico",
    "Guarenas":              "Miranda",
    "Guatire":               "Miranda",
    "Los Teques":            "Miranda",
    "San Antonio de los Altos":"Miranda",
    "Charallave":            "Miranda",
    "Cúa":                   "Miranda",
    "Ocumare del Tuy":       "Miranda",
    "Petare":                "Miranda",
    "San Felipe":            "Yaracuy",
    "Chivacoa":              "Yaracuy",
    "Valera":                "Trujillo",
    "Trujillo":              "Trujillo",
    "Cumaná":                "Sucre",
    "Carúpano":              "Sucre",
    "Porlamar":              "Nueva Esparta",
    "La Asunción":           "Nueva Esparta",
    "Juan Griego":           "Nueva Esparta",
    "Barinas":               "Barinas",
    "Santa Bárbara de Barinas":"Barinas",
    "Tucupita":              "Delta Amacuro",
    "San Fernando de Apure": "Apure",
    "Guanare":               "Portuguesa",
    "Acarigua":              "Portuguesa",
    "San Carlos":            "Cojedes",
    "Puerto Ayacucho":       "Amazonas",
    "La Guaira":             "La Guaira (Vargas)",
    "Macuto":                "La Guaira (Vargas)",
    "Catia La Mar":          "La Guaira (Vargas)",
  };

  /* ── Mapeo accepts (inglés) → TIPOS_INSUMO (español) ── */
  const ACCEPTS_ES = {
    "food":                   "Alimentos no perecederos",
    "water":                  "Agua potable",
    "clothing":               "Ropa y calzado",
    "medicine":               "Medicamentos",
    "hygiene":                "Artículos de higiene",
    "blankets":               "Frazadas y colchonetas",
    "construction_materials": "Materiales de construcción",
    "medical_equipment":      "Equipos médicos",
    "tools":                  "Herramientas",
    "fuel":                   "Combustible",
    "baby_supplies":          "Artículos para bebés",
    "mobility_aids":          "Sillas de ruedas / movilidad",
    "lighting":               "Linternas / velas",
    "other":                  "Otros",
  };

  /* ── Convierte un ítem ResponseGrid al esquema de Acopio VE ── */
  function mapRG(item) {
    const estado = CITY_ESTADO[item.city] || "";
    const insumos = (item.accepts || []).map(a => ACCEPTS_ES[a]).filter(Boolean);
    return {
      id:          item.id,
      nombre:      item.name         || "",
      estado,
      municipio:   item.city         || "",
      direccion:   item.location?.address    || "",
      lat:         item.location?.latitude   || 0,
      lng:         item.location?.longitude  || 0,
      capacidad:   item.publicStatus === "active" ? "disponible" : "lleno",
      insumos,
      contacto:    item.contact      || "",
      responsable: item.manager      || "",
      horario:     item.schedule     || "",
      verificado:  item.verificationLevel === "verified",
      actualizadoEn: item.externalUpdatedAt ? new Date(item.externalUpdatedAt).getTime() : Date.now(),
      _source:     "responsegrid",
    };
  }

  /* ── Distancia en metros entre dos coordenadas ── */
  function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const f1 = lat1 * Math.PI / 180, f2 = lat2 * Math.PI / 180;
    const df = (lat2 - lat1) * Math.PI / 180;
    const dl = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ── Combina centros de RG y Firebase; RG gana ante duplicados (< 300m) ── */
  function mergeSources(rgCentros, fbCentros) {
    const merged = [...rgCentros];
    for (const fb of fbCentros) {
      if (!fb.lat || !fb.lng) continue;
      const esDuplicado = rgCentros.some(
        rg => rg.lat && rg.lng && haversineM(fb.lat, fb.lng, rg.lat, rg.lng) < 300
      );
      if (!esDuplicado) merged.push({ ...fb, _source: fb._source || "firebase" });
    }
    return merged;
  }

  /* ── Caché ResponseGrid ── */
  function cargarRGCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY_RG);
      if (!raw) return null;
      const { ts, centros } = JSON.parse(raw);
      return { centros, edadMinutos: Math.floor((Date.now() - ts) / 60000) };
    } catch (_) { return null; }
  }

  function guardarRGCache(centros) {
    try { localStorage.setItem(CACHE_KEY_RG, JSON.stringify({ ts: Date.now(), centros })); } catch (_) {}
  }

  /* ══════════════════════════════════════════
     ResponseGrid — lee desde Firebase RTDB (/rg_centros)
     (datos sincronizados por scripts/sync-rg.ps1)
     ══════════════════════════════════════════ */
  async function cargarCentrosRG(timeoutMs = 15000) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(`${BASE}/rg_centros.json`, {
        signal: ctrl.signal,
        cache:  "no-store"
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const val = await res.json();
      return val
        ? Object.entries(val).map(([id, c]) => ({ ...c, id: c.id || id, _source: "responsegrid" }))
        : [];
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  /* ══════════════════════════════════════════
     CARGA PRINCIPAL — RG + Firebase fusionados
     ══════════════════════════════════════════ */
  async function cargarCentros(timeoutMs = 15000) {
    // 1. ResponseGrid: usar caché si tiene < 10 min, si no re-fetcher
    let rgCentros = [];
    try {
      const rgCached = cargarRGCache();
      if (rgCached && rgCached.edadMinutos < 10) {
        rgCentros = rgCached.centros;
      } else {
        rgCentros = await cargarCentrosRG(timeoutMs);
        guardarRGCache(rgCentros);
      }
    } catch (e) {
      console.warn("[API] ResponseGrid no disponible:", e.message);
      const rgCached = cargarRGCache();
      if (rgCached) rgCentros = rgCached.centros;
    }

    // 2. Firebase: centros agregados por usuarios
    let fbCentros = [];
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res   = await fetch(`${BASE}/centros.json`, {
        signal: ctrl.signal,
        cache:  "no-store"
      });
      clearTimeout(timer);
      if (res.ok) {
        const val = await res.json();
        fbCentros = val ? Object.entries(val).map(([id, c]) => ({ id, ...c })) : [];
      }
    } catch (e) {
      console.warn("[API] Firebase no disponible:", e.message);
      const fbCached = cargarCentrosCache();
      if (fbCached) fbCentros = fbCached.centros;
    }

    // 3. Fusionar: RG primero, Firebase suma los que no se solapen
    const centros = mergeSources(rgCentros, fbCentros);

    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), centros })); } catch (_) {}
    return centros;
  }

  /** Cargar centros desde caché local (offline) */
  function cargarCentrosCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const { ts, centros } = JSON.parse(raw);
      return { centros, edadMinutos: Math.floor((Date.now() - ts) / 60000) };
    } catch (_) { return null; }
  }

  /* ══════════════════════════════════════════
     ESCRITURA — siempre a Firebase
     ══════════════════════════════════════════ */

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
     REAL-TIME — SSE sobre Firebase + caché RG
     ══════════════════════════════════════════ */
  function escucharCambios(callback) {
    if (!("EventSource" in window)) return null;

    let es     = null;
    let activo = true;

    function procesarFB(val) {
      const fbCentros = val ? Object.entries(val).map(([id, c]) => ({ id, ...c })) : [];
      const rgCached  = cargarRGCache();
      const rgCentros = rgCached ? rgCached.centros : [];
      const merged    = mergeSources(rgCentros, fbCentros);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), centros: merged })); } catch (_) {}
      callback(merged);
    }

    function conectar() {
      if (!activo) return;
      es = new EventSource(`${BASE}/centros.json`);

      es.addEventListener("put", e => {
        if (!activo) return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.path === "/" && msg.data) {
            procesarFB(msg.data);
          } else {
            fetch(`${BASE}/centros.json`, { cache: "no-store" })
              .then(r => r.json())
              .then(val => { if (activo) procesarFB(val); })
              .catch(() => {});
          }
        } catch (_) {}
      });

      es.addEventListener("patch", () => {
        if (!activo) return;
        fetch(`${BASE}/centros.json`, { cache: "no-store" })
          .then(r => r.json())
          .then(val => { if (activo) procesarFB(val); })
          .catch(() => {});
      });

      es.onerror = () => {
        es.close();
        if (activo) setTimeout(conectar, 3000);
      };
    }

    conectar();
    return () => { activo = false; if (es) es.close(); };
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

  async function reportarCentro(id) {
    // Solo aplica a centros Firebase
    if (typeof id === "string" && id.includes("-") && id.length > 30) return; // UUID de RG
    const url  = `${BASE}/centros/${id}/reportes.json`;
    const res  = await fetch(url);
    const prev = (await res.json()) || 0;
    await fetch(url, {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(prev + 1)
    });
    invalidarCache();
  }

  async function eliminarCentro(id) {
    const res = await fetch(`${BASE}/centros/${id}.json`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    invalidarCache();
  }

  /* ── Movimientos ── */
  async function guardarMovimiento(data) {
    const res = await fetch(`${BASE}/movimientos.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, timestamp: Date.now() })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).name;
  }

  async function cargarMovimientos(centroId, limite = 10) {
    const url = `${BASE}/movimientos.json?orderBy="centroId"&equalTo="${encodeURIComponent(centroId)}"&limitToLast=${limite}`;
    const res = await fetch(url);
    if (!res.ok) return {};
    return (await res.json()) || {};
  }

  return {
    cargarCentros,
    cargarCentrosCache,
    crearCentro,
    actualizarCentro,
    eliminarCentro,
    escucharCambios,
    reportarCentro,
    guardarMovimiento,
    cargarMovimientos,
    initSDK() {}   // mantenido por compatibilidad con app.js
  };
})();
