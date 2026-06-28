/**
 * ACOPIO VE — Orquestador principal
 *
 * Flujo de inicio:
 *  1. Inicializar mapa (local, sin CDN)
 *  2. Cargar datos vía REST API (rápido, fiable)
 *  3. Mostrar mapa con datos — garantizado en máx 12 segundos
 *  4. Activar real-time Firebase en background (si la conexión lo permite)
 *  5. Polling de respaldo cada 60 segundos
 */

const App = (() => {

  /* ── Estado ── */
  let todosLosCentros  = [];
  let centroActivo     = null;
  let desuscribirRT    = null;
  let intervaloPolling = null;
  let buscarTexto      = "";
  let sortMode         = "reciente";   // "reciente" | "distancia"
  let userLat          = null;
  let userLng          = null;

  const filtros = {
    estado:    "",
    municipio: "",
    capacidad: new Set(["disponible","parcial","lleno"]),
    insumos:   new Set()
  };

  const APP_URL = "acopio-ve-2026.web.app";
  let ultimaActualizacion = null;

  const OP_SESSION_KEY  = "acopio_op_session";
  const OP_SESSION_TTL  = 8 * 60 * 60 * 1000;
  const OP_SESSION_LONG = 30 * 24 * 60 * 60 * 1000;
  const OTP_TTL         = 15 * 60 * 1000;
  let opEmail = null;

  const RATE_LIMIT_KEY = "acopio_rate";
  const RATE_LIMIT_MAX = 3;

  /* ══════════════════════════════════════════
     INIT — punto de entrada
     ══════════════════════════════════════════ */
  async function init() {
    // 1. Mapa — siempre se inicializa primero (es local, no puede fallar por CDN)
    try {
      MapaAcopio.init();
    } catch (e) {
      console.error("[App] Error init mapa:", e);
      mostrarErrorCarga("Error al inicializar el mapa. Recarga la página.");
      return;
    }

    // 2. UI estática
    poblarSelects();
    poblarCheckboxesInsumos();
    enlazarEventos();
    escucharConexion();
    initOperador();

    // 3. Cargar datos (con timeout y fallback a caché)
    await cargarDatos();

    // 4. Real-time en background (no bloquea el arranque)
    iniciarRealtime();

    // 5. Polling de respaldo (actualiza cada 60s si real-time no está activo)
    iniciarPolling();

    // 6. Deeplink
    procesarDeeplink();

    // 7. Refrescar timestamp cada 30 segundos
    setInterval(actualizarTimestamp, 30000);

    // 8. Service Worker
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(e =>
        console.warn("[SW] No registrado:", e)
      );
      // Recarga automática cuando activa un SW nuevo (funciona con cualquier versión del código)
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.location.reload();
      });
    }
  }

  /* ══════════════════════════════════════════
     CARGA DE DATOS — REST + caché
     ══════════════════════════════════════════ */
  async function cargarDatos(mostrarSpinner = true) {
    if (mostrarSpinner) mostrarLoadingSpinner("Cargando centros...");

    try {
      const centros = await API.cargarCentros(10000);
      todosLosCentros = centros;
      actualizarTimestampDatos(centros);
      actualizarUI();
      actualizarTimestamp();
      ocultarLoading();

      if (centros.length === 0) {
        mostrarToast("No hay centros registrados aún. ¡Agrega el primero!", "info");
      }

    } catch (err) {
      console.warn("[App] REST falló:", err.message, "— intentando caché...");

      // Intentar con caché local
      const cached = API.cargarCentrosCache();
      if (cached) {
        todosLosCentros = cached.centros;
        actualizarUI();
        ocultarLoading();
        mostrarToast(
          `Mostrando datos guardados (hace ${cached.edadMinutos} min). Sin conexión.`,
          "warn"
        );
      } else {
        // Sin datos en ningún lado
        ocultarLoading();
        mostrarErrorCarga("No se pudo cargar los centros y no hay datos en caché.");
      }
    }
  }

  /* ══════════════════════════════════════════
     REAL-TIME — Firebase SDK en background
     ══════════════════════════════════════════ */
  function iniciarRealtime() {
    try {
      API.initSDK();
    } catch (_) { return; }

    desuscribirRT = API.escucharCambios(centros => {
      todosLosCentros = centros;
      actualizarTimestampDatos(centros);
      actualizarUI();
      actualizarTimestamp();
    });
  }

  /* ══════════════════════════════════════════
     POLLING — respaldo si real-time no conecta
     ══════════════════════════════════════════ */
  function iniciarPolling() {
    // Solo corre si real-time no está activo (desuscribirRT === null)
    // Polling de respaldo — corre siempre cada 10s independientemente del SSE
    intervaloPolling = setInterval(async () => {
      try { await cargarDatos(false); } catch (_) {}
    }, 10000);
  }

  /* ══════════════════════════════════════════
     ACTUALIZAR UI
     ══════════════════════════════════════════ */
  function actualizarUI() {
    const filtrados = aplicarFiltros(todosLosCentros);
    MapaAcopio.sincronizarCentros(todosLosCentros, filtrados);
    actualizarStats(filtrados);
    renderizarLista(filtrados);
    actualizarFiltrosBadge();

    // Si hay un panel abierto, actualizarlo
    if (centroActivo) {
      const c = todosLosCentros.find(x => x.id === centroActivo);
      if (c) rellenarPanel(c);
    }
  }

  function aplicarFiltros(centros) {
    const txt = buscarTexto.toLowerCase();
    return centros.filter(c => {
      if (filtros.estado && normEstado(c.estado) !== normEstado(filtros.estado)) return false;
      if (filtros.municipio && !c.municipio.toLowerCase().includes(filtros.municipio.toLowerCase())) return false;
      if (!filtros.capacidad.has(c.capacidad)) return false;
      if (filtros.insumos.size > 0) {
        const insumosCentro = new Set(getInsumosList(c.insumos));
        if (![...filtros.insumos].some(i => insumosCentro.has(i))) return false;
      }
      if (txt && !c.nombre.toLowerCase().includes(txt) &&
          !c.municipio.toLowerCase().includes(txt) &&
          !c.estado.toLowerCase().includes(txt)) return false;
      return true;
    });
  }

  /* ══════════════════════════════════════════
     PANEL DETALLE
     ══════════════════════════════════════════ */
  function abrirPanel(id) {
    const centro = todosLosCentros.find(c => c.id === id);
    if (!centro) return;

    centroActivo = id;
    rellenarPanel(centro);

    const panel = document.getElementById("panel-centro");
    panel.classList.remove("hidden");
    void panel.offsetWidth;
    panel.classList.add("open");
    document.getElementById("map-wrap").classList.add("panel-open");

    MapaAcopio.volarA(centro.lat, centro.lng, 14);
    document.querySelector(`.lista-item[data-id="${id}"]`)?.classList.add("active");
  }

  function cerrarPanel() {
    const panel = document.getElementById("panel-centro");
    panel.classList.remove("open");
    document.getElementById("map-wrap").classList.remove("panel-open");
    document.querySelectorAll(".lista-item.active").forEach(el => el.classList.remove("active"));
    document.getElementById("op-panel-controles").classList.add("hidden");
    opCancelarEliminar();
    centroActivo = null;
    setTimeout(() => { if (!panel.classList.contains("open")) panel.classList.add("hidden"); }, 250);
  }

  function rellenarPanel(c) {
    const capCls  = { disponible:"badge-verde", parcial:"badge-amarillo", lleno:"badge-rojo" };
    const capLabel = { disponible:"Disponible",  parcial:"Parcial",        lleno:"Lleno" };

    setText("p-nombre", c.nombre);
    const badge = document.getElementById("p-badge");
    badge.textContent = capLabel[c.capacidad] || c.capacidad;
    badge.className = `badge ${capCls[c.capacidad] || "badge-amarillo"}`;

    const vBadge = document.getElementById("p-verificado-badge");
    vBadge.classList.toggle("hidden", !c.verificado);

    setText("p-direccion", c.direccion || "—");
    setText("p-ubicacion", [c.municipio, c.estado].filter(Boolean).join(", ") || "—");

    const insumosEl = document.getElementById("p-insumos");
    insumosEl.innerHTML = "";
    const insumosList = getInsumosList(c.insumos);
    if (insumosList.length) {
      insumosList.forEach(ins => {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = ins;
        insumosEl.appendChild(tag);
      });
    } else {
      insumosEl.textContent = "No especificado";
    }

    const contactoEl = document.getElementById("p-contacto");
    if (c.contacto && /^\+?[\d\s\-()]+$/.test(c.contacto)) {
      contactoEl.innerHTML = `<a href="tel:${c.contacto.replace(/\s/g,'')}">${escHtml(c.contacto)}</a>`;
    } else {
      contactoEl.textContent = c.contacto || "No especificado";
    }
    setText("p-responsable", c.responsable || "");

    const horarioRow = document.getElementById("p-horario-row");
    if (c.horario) { setText("p-horario", c.horario); horarioRow.classList.remove("hidden"); }
    else horarioRow.classList.add("hidden");

    const notasRow = document.getElementById("p-notas-row");
    if (c.notas) { setText("p-notas", c.notas); notasRow.classList.remove("hidden"); }
    else notasRow.classList.add("hidden");

    const ts = c.actualizadoEn || c.creadoEn;
    setText("p-actualizado", ts ? "Actualizado " + formatearTiempo(ts) : "Sin fecha");

    // Cómo llegar
    const navRow = document.getElementById("p-nav-row");
    if (c.lat && c.lng) {
      document.getElementById("btn-waze").href = `https://waze.com/ul?ll=${c.lat},${c.lng}&navigate=yes`;
      document.getElementById("btn-gmaps").href = `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`;
      navRow.style.display = "";
    } else {
      navRow.style.display = "none";
    }

    // Fotos
    const fotosRow = document.getElementById("p-fotos-row");
    const fotosEl  = document.getElementById("p-fotos");
    const fotos = Array.isArray(c.fotos) ? c.fotos : [];
    if (fotos.length) {
      fotosEl.innerHTML = fotos.map(url =>
        `<img src="${escHtml(url)}" class="p-foto-img" onclick="window.open('${escHtml(url)}','_blank')" loading="lazy" alt="Foto del centro">`
      ).join("");
      fotosRow.style.display = "";
    } else {
      fotosEl.innerHTML = "";
      fotosRow.style.display = "none";
    }

    // Controles de operador (solo si hay sesión activa)
    document.getElementById("op-panel-controles").classList.toggle("hidden", !opEmail);

    // Reportes de problema
    const rep = c.reportes || 0;
    const repWrap = document.getElementById("p-reportes-wrap");
    const repTxt  = document.getElementById("p-reportes-txt");
    if (rep > 0) {
      repTxt.textContent = `⚠️ ${rep} ${rep === 1 ? "reporte" : "reportes"} de problema en este centro`;
      repWrap.classList.remove("hidden");
    } else {
      repWrap.classList.add("hidden");
    }
  }

  /* ══════════════════════════════════════════
     FORMULARIO: NUEVO CENTRO
     ══════════════════════════════════════════ */
  function abrirModalNuevo() {
    document.getElementById("form-nuevo").reset();
    document.getElementById("n-lat").value = "";
    document.getElementById("n-lng").value = "";
    document.getElementById("n-dir-lista").classList.add("hidden");
    document.getElementById("n-dir-lista").innerHTML = "";
    document.getElementById("modal-nuevo").classList.remove("hidden");
  }

  function cerrarModalNuevo() {
    document.getElementById("modal-nuevo").classList.add("hidden");
    document.getElementById("n-dir-lista").classList.add("hidden");
    document.getElementById("n-dir-lista").innerHTML = "";
    MapaAcopio.desactivarSeleccion();
    MapaAcopio.quitarMarcadorTemp();
    document.getElementById("loc-selecting-hint").classList.add("hidden");
  }

  async function submitNuevoCentro(e) {
    e.preventDefault();

    const insumos   = [...document.querySelectorAll("#n-insumos input:checked")].map(cb => cb.value);
    const capacidad = document.querySelector('input[name="n-capacidad"]:checked')?.value;
    const lat       = parseFloat(document.getElementById("n-lat").value);
    const lng       = parseFloat(document.getElementById("n-lng").value);

    if (!capacidad)       { mostrarToast("Selecciona la capacidad actual.", "err"); return; }
    if (!insumos.length)  { mostrarToast("Selecciona al menos un tipo de insumo.", "err"); return; }
    if (isNaN(lat) || isNaN(lng)) { mostrarToast("Selecciona la ubicación en el mapa.", "err"); return; }

    if (!opEmail && !checkRateLimit()) {
      mostrarToast(`Límite alcanzado: máximo ${RATE_LIMIT_MAX} centros por dispositivo al día. Intenta mañana.`, "err");
      return;
    }

    const dirBase  = document.getElementById("n-direccion").value.trim();
    const dirExtra = document.getElementById("n-dir-extra").value.trim();
    const data = {
      nombre:      document.getElementById("n-nombre").value,
      estado:      document.getElementById("n-estado").value,
      municipio:   document.getElementById("n-municipio").value,
      direccion:   dirExtra ? `${dirBase} — ${dirExtra}` : dirBase,
      lat, lng, capacidad, insumos,
      contacto:    document.getElementById("n-contacto").value,
      responsable: document.getElementById("n-responsable").value,
      horario:     document.getElementById("n-horario").value,
      notas:       document.getElementById("n-notas").value
    };

    const btn = document.getElementById("btn-submit-nuevo");
    btn.disabled = true;
    btn.textContent = "Guardando...";

    try {
      const { id } = await API.crearCentro(data);
      if (!opEmail) incrementRateLimit();
      cerrarModalNuevo();
      ultimaActualizacion = Date.now(); actualizarTimestamp();
      mostrarToast("Centro registrado correctamente.", "ok");
      await cargarDatos(false);
      setTimeout(() => abrirPanel(id), 400);
    } catch (err) {
      mostrarToast(err.message || "Error al guardar. Verifica tu conexión.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Registrar Centro";
    }
  }

  function actualizarCoordsFormulario(lat, lng) {
    document.getElementById("n-lat").value = lat.toFixed(6);
    document.getElementById("n-lng").value = lng.toFixed(6);
  }

  function activarSeleccionUbicacion() {
    const modal = document.getElementById("modal-nuevo");
    modal.classList.add("hidden");
    document.getElementById("selecting-banner").classList.remove("hidden");

    MapaAcopio.activarSeleccion((lat, lng) => {
      actualizarCoordsFormulario(lat, lng);
      MapaAcopio.ponerMarcadorTemp(lat, lng, (lat2, lng2) => {
        actualizarCoordsFormulario(lat2, lng2);
      });
      MapaAcopio.desactivarSeleccion();
      document.getElementById("selecting-banner").classList.add("hidden");
      modal.classList.remove("hidden");
    });
  }

  function cancelarSeleccionUbicacion() {
    MapaAcopio.desactivarSeleccion();
    document.getElementById("selecting-banner").classList.add("hidden");
    document.getElementById("modal-nuevo").classList.remove("hidden");
  }

  /* ══════════════════════════════════════════
     AUTOCOMPLETE — Nominatim (OSM, sin API key)
     ══════════════════════════════════════════ */
  function iniciarAutocompleteDireccion() {
    const input   = document.getElementById("n-direccion");
    const lista   = document.getElementById("n-dir-lista");
    const spinner = document.getElementById("n-dir-spinner");
    let timer = null;
    let ctrl  = null;

    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { cerrarListaAC(); return; }
      timer = setTimeout(() => buscarDir(q), 380);
    });

    input.addEventListener("keydown", e => {
      if (e.key === "Escape")    { cerrarListaAC(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); lista.querySelector("li")?.focus(); }
    });

    document.addEventListener("click", e => {
      if (!e.target.closest(".ac-wrap")) cerrarListaAC();
    }, true);

    async function buscarDir(q) {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      spinner.classList.remove("hidden");
      try {
        const url =
          "https://nominatim.openstreetmap.org/search?" +
          "q=" + encodeURIComponent(q + " Venezuela") +
          "&format=json&limit=6&countrycodes=ve&addressdetails=1";
        const res  = await fetch(url, {
          signal: ctrl.signal,
          headers: { "Accept-Language": "es", "User-Agent": "AcopioVE/1.0" }
        });
        const data = await res.json();
        renderSugerencias(data);
      } catch (err) {
        if (err.name !== "AbortError") cerrarListaAC();
      } finally {
        spinner.classList.add("hidden");
      }
    }

    function renderSugerencias(items) {
      lista.innerHTML = "";
      if (!items || !items.length) { cerrarListaAC(); return; }
      items.forEach(item => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.setAttribute("tabindex", "0");
        li.textContent = item.display_name.split(",").slice(0, 4).join(",");
        li.title = item.display_name;
        li.addEventListener("click",   () => elegirSugerencia(item));
        li.addEventListener("keydown", e => {
          if (e.key === "Enter" || e.key === " ")  { e.preventDefault(); elegirSugerencia(item); }
          if (e.key === "Escape")                  { cerrarListaAC(); input.focus(); }
          if (e.key === "ArrowDown") { e.preventDefault(); (li.nextElementSibling || lista.firstElementChild)?.focus(); }
          if (e.key === "ArrowUp")   { e.preventDefault(); li.previousElementSibling ? li.previousElementSibling.focus() : input.focus(); }
        });
        lista.appendChild(li);
      });
      lista.classList.remove("hidden");
    }

    function elegirSugerencia(item) {
      const addr  = item.address || {};
      const partes = item.display_name.split(",");
      input.value = partes.slice(0, Math.min(3, partes.length)).join(",").trim();

      const est = matchEstado(addr.state || addr.region || "");
      if (est) document.getElementById("n-estado").value = est;

      const muni = addr.county || addr.municipality || addr.city || addr.town || addr.village || "";
      if (muni) document.getElementById("n-municipio").value = muni;

      const lat = parseFloat(item.lat);
      const lng = parseFloat(item.lon);
      actualizarCoordsFormulario(lat, lng);
      MapaAcopio.ponerMarcadorTemp(lat, lng, (lat2, lng2) => actualizarCoordsFormulario(lat2, lng2));
      MapaAcopio.volarA(lat, lng, 15);
      cerrarListaAC();
    }

    function cerrarListaAC() {
      lista.classList.add("hidden");
      lista.innerHTML = "";
    }
  }

  function matchEstado(raw) {
    if (!raw) return null;
    const norm = s => s.toLowerCase()
      .replace(/^estado\s+/i, "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .trim();
    const t = norm(raw);
    if (!t) return null;
    if (t.includes("vargas") || t.includes("guaira")) return "La Guaira (Vargas)";
    if (t === "distrito capital" || t.includes("capital federal")) return "Distrito Capital";
    return (
      ESTADOS_VE.find(e => norm(e) === t) ||
      ESTADOS_VE.find(e => t.includes(norm(e)) || norm(e).includes(t)) ||
      null
    );
  }

  /* ══════════════════════════════════════════
     DISTANCIA — Haversine
     ══════════════════════════════════════════ */
  function calcularDistancia(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) ** 2
            + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatDistancia(km) {
    return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
  }

  function obtenerUbicacionUsuario(callback) {
    if (!navigator.geolocation) { mostrarToast("Tu dispositivo no soporta geolocalización.", "err"); return; }
    navigator.geolocation.getCurrentPosition(
      pos => { userLat = pos.coords.latitude; userLng = pos.coords.longitude; if (callback) callback(); },
      ()  => mostrarToast("No se pudo obtener tu ubicación.", "err"),
      { timeout: 8000, enableHighAccuracy: true }
    );
  }

  function toggleSortMode() {
    if (sortMode === "reciente") {
      sortMode = "distancia";
      document.getElementById("btn-sort-label").textContent = "Más cercanos";
      if (!userLat) {
        obtenerUbicacionUsuario(() => actualizarUI());
      } else {
        actualizarUI();
      }
    } else {
      sortMode = "reciente";
      document.getElementById("btn-sort-label").textContent = "Más recientes";
      actualizarUI();
    }
  }

  /* ══════════════════════════════════════════
     FOTOS — Firebase Storage REST API
     ══════════════════════════════════════════ */
  async function subirFotoDrive(file, centroId) {
    if (!DRIVE_UPLOAD_URL) throw new Error("Configura DRIVE_UPLOAD_URL en config.js con la URL de tu Apps Script.");

    // Redimensionar a máx 1200px y comprimir a JPEG antes de enviar
    const base64 = await new Promise((resolve, reject) => {
      const img    = new Image();
      const objUrl = URL.createObjectURL(file);
      img.onload = () => {
        const MAX_W = 1200;
        const ratio  = Math.min(1, MAX_W / img.width);
        const canvas = document.createElement("canvas");
        canvas.width  = Math.round(img.width  * ratio);
        canvas.height = Math.round(img.height * ratio);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(objUrl);
        resolve(canvas.toDataURL("image/jpeg", 0.82).split(",")[1]);
      };
      img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error("No se pudo leer la imagen")); };
      img.src = objUrl;
    });

    // Enviar sin Content-Type JSON para evitar CORS preflight en Apps Script
    const res  = await fetch(DRIVE_UPLOAD_URL, {
      method: "POST",
      body:   JSON.stringify({ base64, mimeType: "image/jpeg", filename: `foto_${centroId}_${Date.now()}.jpg`, centroId })
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error("Respuesta inesperada del servidor: " + text.slice(0, 120)); }
    if (!data.success) throw new Error(data.error || "Error desconocido al subir a Drive");
    return data.url;
  }

  async function opAgregarFoto(file) {
    if (!file || !centroActivo || !opEmail) return;
    const label = document.getElementById("btn-op-foto-label");
    label.textContent = "Subiendo...";
    try {
      const fotoUrl = await subirFotoDrive(file, centroActivo);
      const c = todosLosCentros.find(x => x.id === centroActivo);
      const fotos = Array.isArray(c?.fotos) ? [...c.fotos, fotoUrl] : [fotoUrl];
      const res = await fetch(`${FIREBASE_CONFIG.databaseURL}/centros/${centroActivo}.json`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ fotos, actualizadoEn: Date.now() })
      });
      if (!res.ok) throw new Error("Error al guardar en base de datos");
      mostrarToast("Foto agregada correctamente.", "ok");
      await cargarDatos(false);
    } catch (e) {
      mostrarToast("Error al subir foto: " + (e.message || "sin conexión"), "err");
    } finally {
      label.textContent = "Agregar foto";
      document.getElementById("op-foto-input").value = "";
    }
  }

  /* ══════════════════════════════════════════
     EXPORTAR PDF — ventana imprimible
     ══════════════════════════════════════════ */
  function exportarPDF() {
    const centros = aplicarFiltros(todosLosCentros);
    if (!centros.length) { mostrarToast("No hay centros para exportar.", "err"); return; }

    const capLabel = { disponible: "Disponible", parcial: "Parcial", lleno: "Lleno" };
    const capColor = { disponible: "#27AE60",    parcial: "#F39C12", lleno: "#E74C3C" };

    const filas = centros.map(c => {
      const ins = getInsumosList(c.insumos).join(", ");
      return `<tr>
        <td><strong>${escHtml(c.nombre)}</strong>${c.verificado ? ' <span style="color:#27AE60">✓</span>' : ""}</td>
        <td>${escHtml(c.estado)}</td>
        <td>${escHtml(c.municipio)}</td>
        <td><span style="color:${capColor[c.capacidad]||"#F39C12"};font-weight:700">${capLabel[c.capacidad]||c.capacidad}</span></td>
        <td style="font-size:.82em">${escHtml(ins)}</td>
        <td style="font-size:.82em">${escHtml(c.contacto||"")}</td>
      </tr>`;
    }).join("");

    const fecha = new Date().toLocaleString("es-VE");
    const win = window.open("", "_blank");
    if (!win) { mostrarToast("Permite ventanas emergentes para exportar PDF.", "warn"); return; }
    win.document.write(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>Acopio VE — Centros de Acopio</title>
<style>
  body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:20px;max-width:1000px;margin:0 auto}
  h1{font-size:18px;margin:0 0 2px;color:#E63946}
  .sub{color:#666;font-size:10px;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{background:#E63946;color:#fff;padding:7px 8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.5px}
  td{padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top}
  tr:nth-child(even){background:#fafafa}
  .footer{margin-top:14px;color:#999;font-size:10px;border-top:1px solid #eee;padding-top:8px}
  button{padding:7px 16px;background:#E63946;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;margin-bottom:12px}
  @media print{button{display:none}}
</style></head><body>
<h1>🏠 Centros de Acopio — Venezuela</h1>
<p class="sub">Exportado el ${escHtml(fecha)} · ${centros.length} centros · acopio-ve-2026.web.app</p>
<button onclick="window.print()">Imprimir / Guardar como PDF</button>
<table>
  <thead><tr><th>Nombre</th><th>Estado</th><th>Municipio</th><th>Capacidad</th><th>Acepta</th><th>Contacto</th></tr></thead>
  <tbody>${filas}</tbody>
</table>
<p class="footer">Generado desde Acopio VE (acopio-ve-2026.web.app) · Verifica información antes de ir · Datos en tiempo real</p>
</body></html>`);
    win.document.close();
    mostrarToast(`PDF con ${centros.length} centros listo.`, "ok");
  }

  /* ══════════════════════════════════════════
     QR CODE
     ══════════════════════════════════════════ */
  function mostrarQR(id) {
    const c = todosLosCentros.find(x => x.id === id);
    if (!c) return;

    if (typeof QRCode === "undefined") {
      mostrarToast("Error al cargar QR. Verifica tu conexión.", "err");
      return;
    }

    document.getElementById("qr-centro-nombre").textContent = c.nombre;
    const container = document.getElementById("qr-container");
    container.innerHTML = "";

    new QRCode(container, {
      text:           `https://${APP_URL}?id=${id}`,
      width:          220,
      height:         220,
      colorDark:      "#111111",
      colorLight:     "#ffffff",
      correctLevel:   QRCode.CorrectLevel.M
    });

    document.getElementById("modal-qr").classList.remove("hidden");

    // Actualizar enlace de descarga una vez que el canvas esté listo
    setTimeout(() => {
      const canvas = container.querySelector("canvas");
      if (canvas) document.getElementById("btn-descargar-qr").href = canvas.toDataURL("image/png");
    }, 150);
  }

  function cerrarModalQR() {
    document.getElementById("modal-qr").classList.add("hidden");
  }

  /* ══════════════════════════════════════════
     EXPORTAR CSV
     ══════════════════════════════════════════ */
  function exportarCSV() {
    const centros = aplicarFiltros(todosLosCentros);
    if (!centros.length) { mostrarToast("No hay centros para exportar.", "err"); return; }

    const cols = ["nombre","estado","municipio","direccion","capacidad","insumos","contacto","responsable","horario","lat","lng","creadoEn","actualizadoEn"];
    const esc  = v => `"${String(v || "").replace(/"/g, '""')}"`;
    const rows = centros.map(c => cols.map(k => {
      const v = c[k];
      if (k === "insumos") return esc(getInsumosList(v).join(" | "));
      if (k === "creadoEn" || k === "actualizadoEn") return esc(v ? new Date(v).toLocaleString("es-VE") : "");
      return esc(v);
    }).join(","));

    const csv  = [cols.join(","), ...rows].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const a    = document.createElement("a");
    a.href     = URL.createObjectURL(blob);
    a.download = `AcopioVE_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    mostrarToast(`${centros.length} centros exportados.`, "ok");
  }

  /* ══════════════════════════════════════════
     REPORTAR PROBLEMA
     ══════════════════════════════════════════ */
  async function reportarCentroProblema(id) {
    try {
      await API.reportarCentro(id);
      mostrarToast("Reporte enviado. Gracias por ayudar.", "ok");
      await cargarDatos(false);
    } catch (e) {
      mostrarToast("No se pudo enviar el reporte.", "err");
    }
  }

  /* ══════════════════════════════════════════
     IMAGEN PARA WHATSAPP STATUS (Canvas 9:16)
     ══════════════════════════════════════════ */
  function abrirModalWA() {
    const texto =
`*CENTROS DE ACOPIO — VENEZUELA* 🇻🇪

Mapa en tiempo real de centros de acopio para damnificados por el terremoto.

📍 Encuentra el centro más cercano a ti, filtra por estado, insumos y capacidad.

🔗 https://${APP_URL}

Comparte con familiares y comunidades que necesiten ayuda 🙏`;

    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, "_blank");
  }

  function cerrarModalWA() {
    document.getElementById("modal-wa").classList.add("hidden");
  }

  function generarImagenWA() {
    const canvas = document.getElementById("wa-canvas");
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext("2d");

    const filtrados = aplicarFiltros(todosLosCentros);
    const total  = filtrados.length;
    const disp   = filtrados.filter(c => c.capacidad === "disponible").length;
    const parc   = filtrados.filter(c => c.capacidad === "parcial").length;
    const llen   = filtrados.filter(c => c.capacidad === "lleno").length;

    // Fondo degradado oscuro → rojo
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0,   "#111111");
    grad.addColorStop(0.5, "#1C1C1E");
    grad.addColorStop(1,   "#6B0000");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Banda superior roja
    ctx.fillStyle = "#E63946";
    ctx.fillRect(0, 0, W, 12);
    ctx.fillRect(0, H - 12, W, 12);

    // Línea divisoria
    const linea = (y) => {
      ctx.strokeStyle = "rgba(255,255,255,.15)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(60, y); ctx.lineTo(W - 60, y); ctx.stroke();
    };

    // ── Sección 1: Alerta ──
    ctx.textAlign = "center";
    ctx.fillStyle = "#E63946";
    ctx.font = `bold 58px -apple-system, Arial, sans-serif`;
    ctx.fillText("🆘 ALERTA HUMANITARIA", W/2, 120);

    ctx.fillStyle = "white";
    ctx.font = `bold 72px -apple-system, Arial, sans-serif`;
    ctx.fillText("VENEZUELA", W/2, 210);

    linea(260);

    // ── Sección 2: Descripción ──
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.font = `500 40px -apple-system, Arial, sans-serif`;
    ctx.fillText("Centros de Acopio activos", W/2, 330);
    ctx.fillText("mapeados en tiempo real", W/2, 385);

    // ── Sección 3: Número grande ──
    ctx.fillStyle = "#FFD60A";
    ctx.font      = `bold 200px -apple-system, Arial, sans-serif`;
    ctx.fillText(String(total || "—"), W/2, 620);

    ctx.fillStyle = "rgba(255,255,255,.6)";
    ctx.font      = `500 38px -apple-system, Arial, sans-serif`;
    ctx.fillText("centros registrados", W/2, 680);

    linea(730);

    // ── Sección 4: Stats ──
    const statX = [W * 0.18, W * 0.5, W * 0.82];
    const statY = 810;
    const statColors = ["#2ECC71", "#F1C40F", "#E74C3C"];
    const statLabels = ["Disponibles", "Parciales", "Llenos"];
    const statVals   = [disp, parc, llen];

    statVals.forEach((v, i) => {
      ctx.fillStyle = statColors[i];
      ctx.font      = `bold 90px -apple-system, Arial, sans-serif`;
      ctx.fillText(String(v), statX[i], statY);
      ctx.fillStyle = "rgba(255,255,255,.6)";
      ctx.font      = `500 30px -apple-system, Arial, sans-serif`;
      ctx.fillText(statLabels[i], statX[i], statY + 46);
    });

    linea(900);

    // ── Sección 5: CTA ──
    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.font      = `500 36px -apple-system, Arial, sans-serif`;
    ctx.fillText("Encuentra el centro más cercano en:", W/2, 980);

    ctx.fillStyle = "white";
    ctx.font      = `bold 46px -apple-system, Arial, sans-serif`;
    ctx.fillText(APP_URL, W/2, 1050);

    // Caja del URL
    ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    const urlW = 420, urlH = 70, urlX = W/2 - urlW/2, urlY = 970;
    ctx.roundRect(urlX, urlY, urlW, urlH, 12);
    ctx.stroke();

    linea(1110);

    // ── Sección 6: Hashtags ──
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.font      = `500 34px -apple-system, Arial, sans-serif`;
    ctx.fillText("#AcopioVE  #VenezuelaSeLevanta", W/2, 1200);
    ctx.fillText("#AyudaVenezuela  🇻🇪", W/2, 1250);

    linea(1300);

    // ── Sección 7: Footer ──
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.font      = `500 28px -apple-system, Arial, sans-serif`;
    ctx.fillText("Comparte esta imagen para ayudar a más venezolanos", W/2, 1380);

    ctx.fillStyle = "#E63946";
    ctx.font      = `bold 32px -apple-system, Arial, sans-serif`;
    ctx.fillText("❤️  Comparte · Comparte · Comparte", W/2, 1440);

    // Actualizar link de descarga
    const img = canvas.toDataURL("image/png");
    document.getElementById("btn-descargar-wa").href = img;
  }

  function usarMiUbicacion() {
    if (!navigator.geolocation) {
      mostrarToast("Tu dispositivo no soporta geolocalización.", "err");
      return;
    }
    const btn = document.getElementById("btn-mi-ubicacion");
    btn.textContent = "Obteniendo GPS...";
    btn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        actualizarCoordsFormulario(lat, lng);
        MapaAcopio.ponerMarcadorTemp(lat, lng, (lat2, lng2) => {
          actualizarCoordsFormulario(lat2, lng2);
        });
        MapaAcopio.volarA(lat, lng, 15);
        mostrarToast("Ubicación obtenida.", "ok");
        btn.textContent = "📍 Usar mi GPS";
        btn.disabled = false;
      },
      err => {
        mostrarToast("No se pudo obtener la ubicación.", "err");
        btn.textContent = "📍 Usar mi GPS";
        btn.disabled = false;
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  }

  /* ══════════════════════════════════════════
     FORMULARIO: ACTUALIZAR
     ══════════════════════════════════════════ */
  function abrirModalActualizar(id) {
    const c = todosLosCentros.find(c => c.id === id);
    if (!c) return;

    document.getElementById("act-id").value = id;
    document.getElementById("act-nombre-label").textContent = c.nombre;
    document.getElementById("act-contacto").value = c.contacto || "";
    document.getElementById("act-notas").value = "";

    const radio = document.querySelector(`input[name="act-capacidad"][value="${c.capacidad}"]`);
    if (radio) radio.checked = true;

    const insumosList = getInsumosList(c.insumos);
    document.querySelectorAll("#act-insumos input").forEach(cb => {
      cb.checked = insumosList.includes(cb.value);
    });

    // Campos extra para operadores
    if (opEmail) {
      document.getElementById("act-modal-titulo").textContent = "Editar Centro";
      document.getElementById("act-nombre").value      = c.nombre      || "";
      document.getElementById("act-estado").value      = c.estado      || "";
      document.getElementById("act-municipio").value   = c.municipio   || "";
      document.getElementById("act-direccion").value   = c.direccion   || "";
      document.getElementById("act-responsable").value = c.responsable || "";
      document.getElementById("act-horario").value     = c.horario     || "";
    } else {
      document.getElementById("act-modal-titulo").textContent = "Actualizar Estado";
    }

    document.getElementById("modal-actualizar").classList.remove("hidden");
  }

  function cerrarModalActualizar() {
    document.getElementById("modal-actualizar").classList.add("hidden");
  }

  async function submitActualizarCentro(e) {
    e.preventDefault();
    const id = document.getElementById("act-id").value;
    const capacidad = document.querySelector('input[name="act-capacidad"]:checked')?.value;
    const insumos = [...document.querySelectorAll("#act-insumos input:checked")].map(cb => cb.value);

    if (!capacidad) { mostrarToast("Selecciona la nueva capacidad.", "err"); return; }

    const btn = document.getElementById("btn-submit-actualizar");
    btn.disabled = true;
    btn.textContent = "Guardando...";

    // Campos extra solo si el operador está activo
    const extraData = {};
    if (opEmail) {
      const nombre    = document.getElementById("act-nombre").value.trim();
      const estado    = document.getElementById("act-estado").value;
      const municipio = document.getElementById("act-municipio").value.trim();
      const direccion = document.getElementById("act-direccion").value.trim();
      const responsable = document.getElementById("act-responsable").value.trim();
      const horario   = document.getElementById("act-horario").value.trim();
      if (nombre)    extraData.nombre    = nombre;
      if (estado)    extraData.estado    = estado;
      if (municipio) extraData.municipio = municipio;
      if (direccion) extraData.direccion = direccion;
      if (responsable) extraData.responsable = responsable;
      if (horario)   extraData.horario   = horario;
    }

    try {
      await API.actualizarCentro(id, {
        capacidad,
        insumos: insumos.length ? insumos : undefined,
        contacto: document.getElementById("act-contacto").value,
        notas:    document.getElementById("act-notas").value,
        ...extraData
      });
      cerrarModalActualizar();
      ultimaActualizacion = Date.now(); actualizarTimestamp();
      mostrarToast("Estado actualizado.", "ok");
      await cargarDatos(false);
    } catch (err) {
      mostrarToast(err.message || "Error al actualizar.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Guardar Cambios";
    }
  }

  /* ══════════════════════════════════════════
     FILTROS
     ══════════════════════════════════════════ */
  function enlazarFiltros() {
    document.getElementById("filtro-estado").addEventListener("change", e => {
      filtros.estado = e.target.value;
      actualizarUI();
    });

    let debounce;
    document.getElementById("filtro-municipio").addEventListener("input", e => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { filtros.municipio = e.target.value.trim(); actualizarUI(); }, 300);
    });

    document.querySelectorAll(".filtro-capacidad").forEach(cb => {
      cb.addEventListener("change", () => {
        filtros.capacidad = new Set(
          [...document.querySelectorAll(".filtro-capacidad:checked")].map(c => c.value)
        );
        actualizarUI();
      });
    });

    document.getElementById("btn-limpiar-filtros").addEventListener("click", limpiarFiltros);

    // Quick filter bar
    const qfEstado = document.getElementById("qf-estado");
    if (qfEstado) {
      qfEstado.addEventListener("change", e => {
        filtros.estado = e.target.value;
        document.getElementById("filtro-estado").value = e.target.value;
        sincronizarQF();
        actualizarUI();
      });
    }

    document.querySelectorAll(".qf-chip[data-cap]").forEach(btn => {
      btn.addEventListener("click", () => {
        const cap = btn.dataset.cap;
        if (filtros.capacidad.size === 3) {
          filtros.capacidad = new Set([cap]);
        } else if (filtros.capacidad.has(cap) && filtros.capacidad.size === 1) {
          filtros.capacidad = new Set(["disponible","parcial","lleno"]);
        } else if (filtros.capacidad.has(cap)) {
          filtros.capacidad.delete(cap);
        } else {
          filtros.capacidad.add(cap);
        }
        document.querySelectorAll(".filtro-capacidad").forEach(cb => {
          cb.checked = filtros.capacidad.has(cb.value);
        });
        sincronizarQF();
        actualizarUI();
      });
    });

    const qfClear = document.getElementById("qf-clear");
    if (qfClear) qfClear.addEventListener("click", limpiarFiltros);

    // Keep sidebar estado in sync when QF estado changes
    document.getElementById("filtro-estado").addEventListener("change", () => sincronizarQF());
    document.querySelectorAll(".filtro-capacidad").forEach(cb => {
      cb.addEventListener("change", () => sincronizarQF());
    });
  }

  function limpiarFiltros() {
    filtros.estado = ""; filtros.municipio = "";
    filtros.capacidad = new Set(["disponible","parcial","lleno"]);
    filtros.insumos = new Set();
    document.getElementById("filtro-estado").value = "";
    document.getElementById("filtro-municipio").value = "";
    document.querySelectorAll(".filtro-capacidad").forEach(cb => cb.checked = true);
    document.querySelectorAll("#filtro-insumos input").forEach(cb => cb.checked = false);
    sincronizarQF();
    actualizarUI();
  }

  function sincronizarQF() {
    const qfEstado = document.getElementById("qf-estado");
    if (qfEstado) qfEstado.value = filtros.estado || "";

    document.querySelectorAll(".qf-chip[data-cap]").forEach(btn => {
      const cap = btn.dataset.cap;
      const active = filtros.capacidad.has(cap) && filtros.capacidad.size < 3 ? "1" : "0";
      btn.dataset.active = active;
    });

    const clearBtn = document.getElementById("qf-clear");
    const hayFiltro = filtros.estado || filtros.municipio ||
      filtros.capacidad.size < 3 || filtros.insumos.size > 0;
    if (clearBtn) clearBtn.classList.toggle("hidden", !hayFiltro);
  }

  /* ══════════════════════════════════════════
     SIDEBAR
     ══════════════════════════════════════════ */
  function toggleSidebar() {
    const sb = document.getElementById("sidebar");
    const open = sb.classList.toggle("open");
    sb.setAttribute("aria-hidden", !open);
  }
  function cerrarSidebar() {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebar").setAttribute("aria-hidden", "true");
  }

  /* ══════════════════════════════════════════
     LISTA Y STATS
     ══════════════════════════════════════════ */
  function renderizarLista(centros) {
    document.getElementById("lista-count").textContent = `(${centros.length})`;
    const container = document.getElementById("lista-items");

    if (!centros.length) {
      container.innerHTML = `<div class="lista-empty">No hay centros con estos filtros.</div>`;
      return;
    }

    const capLabel = { disponible: "Disponible", parcial: "Parcial", lleno: "Lleno" };
    const capBadge = { disponible: "badge-verde", parcial: "badge-amarillo", lleno: "badge-rojo" };
    const STALE_MS = 48 * 60 * 60 * 1000; // 48 horas

    let sorted;
    if (sortMode === "distancia" && userLat !== null) {
      sorted = [...centros].sort((a, b) => {
        const dA = (a.lat && a.lng) ? calcularDistancia(userLat, userLng, a.lat, a.lng) : Infinity;
        const dB = (b.lat && b.lng) ? calcularDistancia(userLat, userLng, b.lat, b.lng) : Infinity;
        return dA - dB;
      });
    } else {
      sorted = [...centros].sort((a, b) => (b.actualizadoEn || 0) - (a.actualizadoEn || 0));
    }

    container.innerHTML = sorted.map(c => {
      const badge  = capBadge[c.capacidad] || "badge-amarillo";
      const label  = capLabel[c.capacidad] || c.capacidad;
      const ts     = c.actualizadoEn || c.creadoEn || 0;
      const stale  = ts && (Date.now() - ts) > STALE_MS;
      const dist   = (sortMode === "distancia" && userLat && c.lat && c.lng)
        ? `<span class="lista-dist">${formatDistancia(calcularDistancia(userLat, userLng, c.lat, c.lng))}</span>`
        : "";
      const staleBadge    = stale ? `<span class="lista-stale" title="Sin actualizar en más de 48h">⚠</span>` : "";
      const reportBadge   = (c.reportes >= 3) ? `<span class="lista-reporte" title="${c.reportes} reportes de problema">🚩</span>` : "";
      const verificBadge  = c.verificado ? `<span class="lista-verif" title="Centro verificado por un operador">✓</span>` : "";
      return `
        <div class="lista-item" data-id="${c.id}" data-cap="${c.capacidad}" role="button" tabindex="0">
          <div class="lista-info">
            <div class="lista-nombre">${escHtml(c.nombre)} ${verificBadge}${staleBadge}${reportBadge}</div>
            <div class="lista-sub">${escHtml(c.municipio)}, ${escHtml(c.estado)} ${dist}</div>
          </div>
          <span class="badge ${badge}">${label}</span>
        </div>`;
    }).join("");

    container.querySelectorAll(".lista-item").forEach(el => {
      el.addEventListener("click", () => { abrirPanel(el.dataset.id); cerrarSidebar(); });
      el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") abrirPanel(el.dataset.id); });
    });
  }

  function actualizarStats(filtrados) {
    const total = filtrados.length;
    const disp  = filtrados.filter(c => c.capacidad === "disponible").length;
    const parc  = filtrados.filter(c => c.capacidad === "parcial").length;
    const llen  = filtrados.filter(c => c.capacidad === "lleno").length;

    // Sidebar stats (pequeños, dentro del panel de filtros)
    document.getElementById("stat-total").textContent       = total;
    document.getElementById("stat-disponibles").textContent = disp;
    document.getElementById("stat-parciales").textContent   = parc;
    document.getElementById("stat-llenos").textContent      = llen;

    // Header stats (prominentes, siempre visibles)
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set("hstat-total", total);
    set("hstat-disp",  disp);
    set("hstat-parc",  parc);
    set("hstat-llen",  llen);
  }

  function actualizarFiltrosBadge() {
    let n = 0;
    if (filtros.estado) n++;
    if (filtros.municipio) n++;
    if (filtros.capacidad.size < 3) n++;
    if (filtros.insumos.size > 0) n++;
    const badge = document.getElementById("filtros-badge");
    badge.textContent = n;
    badge.classList.toggle("hidden", n === 0);
  }

  /* ══════════════════════════════════════════
     COMPARTIR
     ══════════════════════════════════════════ */
  function compartirWA(id) {
    const c = todosLosCentros.find(x => x.id === id);
    if (!c) return;
    const url    = `https://${APP_URL}?id=${id}`;
    const estado = { disponible: "🟢 Disponible", parcial: "🟡 Parcial", lleno: "🔴 Lleno" }[c.capacidad] || c.capacidad;
    const insumos = getInsumosList(c.insumos).slice(0, 5).join(", ");
    const texto = `🆘 *Centro de Acopio — Venezuela*\n\n` +
      `📍 *${c.nombre}*\n${c.direccion}, ${c.municipio}, ${c.estado}\n\n` +
      `Estado: ${estado}\n` +
      (insumos ? `Acepta: ${insumos}\n` : "") +
      (c.contacto ? `📞 ${c.contacto}\n` : "") +
      `\n🔗 Ver en el mapa: ${url}\n\n` +
      `_Comparte para ayudar a más venezolanos_ 🇻🇪`;
    const waUrl = `https://wa.me/?text=${encodeURIComponent(texto)}`;
    window.open(waUrl, "_blank");
  }

  /* ══════════════════════════════════════════
     COMPARTIR — Web Share API con fallback WA
     ══════════════════════════════════════════ */
  async function compartirCentro(id) {
    const c = todosLosCentros.find(x => x.id === id);
    if (!c) return;
    const url = `https://${APP_URL}?id=${id}`;
    const estado = { disponible: "Disponible", parcial: "Parcial", lleno: "Lleno" }[c.capacidad] || c.capacidad;
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Centro de Acopio: ${c.nombre}`,
          text: `${c.nombre}\n${c.municipio}, ${c.estado} — ${estado}`,
          url
        });
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }
    compartirWA(id);
  }

  /* ══════════════════════════════════════════
     RATE LIMITING — máx 3 centros / dispositivo / día
     ══════════════════════════════════════════ */
  function checkRateLimit() {
    const hoy = new Date().toISOString().slice(0, 10);
    let data = {};
    try { data = JSON.parse(localStorage.getItem(RATE_LIMIT_KEY) || "{}"); } catch (_) {}
    if (data.fecha !== hoy) return true;
    return (data.count || 0) < RATE_LIMIT_MAX;
  }

  function incrementRateLimit() {
    const hoy = new Date().toISOString().slice(0, 10);
    let data = {};
    try { data = JSON.parse(localStorage.getItem(RATE_LIMIT_KEY) || "{}"); } catch (_) {}
    if (data.fecha !== hoy) data = { fecha: hoy, count: 0 };
    data.count = (data.count || 0) + 1;
    localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(data));
  }

  /* ══════════════════════════════════════════
     ADMIN — Acceso directo por contraseña
     (sin botón público — atajo Ctrl+Shift+A)
     ══════════════════════════════════════════ */

  function abrirModalAdmin() {
    document.getElementById("admin-pass-input").value = "";
    document.getElementById("modal-admin").classList.remove("hidden");
    setTimeout(() => document.getElementById("admin-pass-input").focus(), 80);
  }

  function cerrarModalAdmin() {
    document.getElementById("modal-admin").classList.add("hidden");
    document.getElementById("admin-pass-input").value = "";
  }

  function verificarAdmin() {
    const pass = document.getElementById("admin-pass-input").value;
    if (pass === ADMIN_PASSWORD) {
      const recordar = true; // admin siempre recuerda 30 días
      localStorage.setItem(OP_SESSION_KEY, JSON.stringify({
        email: ADMIN_EMAIL, ts: Date.now(), recordar, esAdmin: true
      }));
      cerrarModalAdmin();
      mostrarModoOperador(ADMIN_EMAIL);
      mostrarToast("Sesión de administrador activa.", "ok");
    } else {
      document.getElementById("admin-pass-input").value = "";
      document.getElementById("admin-pass-input").placeholder = "Contraseña incorrecta";
      setTimeout(() => {
        document.getElementById("admin-pass-input").placeholder = "Contraseña";
      }, 2000);
    }
  }

  /* ══════════════════════════════════════════
     OPERADORES — Autenticación por OTP
     ══════════════════════════════════════════ */

  function emailToKey(email) {
    return email.toLowerCase().replace(/[.@+]/g, "_");
  }

  function generarOTP() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function abrirModalOperadores() {
    document.getElementById("op-email-input").value  = "";
    document.getElementById("op-code-input").value   = "";
    document.getElementById("op-step-1").classList.remove("hidden");
    document.getElementById("op-step-2").classList.add("hidden");
    document.getElementById("modal-op").classList.remove("hidden");
    setTimeout(() => document.getElementById("op-email-input").focus(), 80);
  }

  function cerrarModalOperadores() {
    document.getElementById("modal-op").classList.add("hidden");
  }

  async function enviarCodigoOperador() {
    const email = document.getElementById("op-email-input").value.trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      mostrarToast("Ingresa un correo electrónico válido.", "err");
      return;
    }

    if (OPERADORES_EMAILS.length &&
        !OPERADORES_EMAILS.map(e => e.toLowerCase()).includes(email)) {
      mostrarToast("Este correo no está autorizado como operador.", "err");
      return;
    }

    const btn = document.getElementById("btn-op-enviar");
    btn.disabled = true;
    btn.textContent = "Enviando...";

    try {
      const code   = generarOTP();
      const expiry = Date.now() + OTP_TTL;
      const url    = `${FIREBASE_CONFIG.databaseURL}/otps/${emailToKey(email)}.json`;

      const res = await fetch(url, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code, expiry })
      });
      if (!res.ok) throw new Error("No se pudo guardar el código.");

      if (EMAILJS_PUBLIC_KEY && EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID) {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID,
          { to_email: email, otp_code: code }, EMAILJS_PUBLIC_KEY);
        mostrarToast(`Código enviado a ${email}. Revisa tu correo.`, "ok");
      } else {
        // Modo prueba: código visible en pantalla y consola
        mostrarToast(`🔐 MODO PRUEBA — Tu código: ${code}`, "info");
        console.info(`[Operadores] OTP (modo prueba): ${code}`);
      }

      document.getElementById("op-email-label").textContent = email;
      document.getElementById("op-step-1").classList.add("hidden");
      document.getElementById("op-step-2").classList.remove("hidden");
      setTimeout(() => document.getElementById("op-code-input").focus(), 80);

    } catch (err) {
      mostrarToast("Error al enviar el código. Verifica tu conexión.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Enviar código temporal";
    }
  }

  async function verificarCodigoOperador() {
    const email = document.getElementById("op-email-label").textContent.trim().toLowerCase();
    const code  = document.getElementById("op-code-input").value.trim();

    if (!code || code.length < 6) {
      mostrarToast("Ingresa el código de 6 dígitos.", "err");
      return;
    }

    const btn = document.getElementById("btn-op-verificar-code");
    btn.disabled = true;
    btn.textContent = "Verificando...";

    try {
      const url = `${FIREBASE_CONFIG.databaseURL}/otps/${emailToKey(email)}.json`;
      const res  = await fetch(url);
      const data = await res.json();

      if (!data || !data.code || !data.expiry)
        throw new Error("Código no encontrado. Solicita uno nuevo.");
      if (Date.now() > data.expiry)
        throw new Error("El código expiró. Solicita uno nuevo.");
      if (data.code !== code)
        throw new Error("Código incorrecto. Intenta de nuevo.");

      // Eliminar OTP ya usado
      await fetch(url, { method: "DELETE" });

      const recordar = document.getElementById("op-recordar")?.checked;
      localStorage.setItem(OP_SESSION_KEY, JSON.stringify({ email, ts: Date.now(), recordar }));
      cerrarModalOperadores();
      mostrarModoOperador(email);
      mostrarToast(recordar ? "Sesión guardada por 30 días." : "Acceso de operador activado.", "ok");

    } catch (err) {
      mostrarToast(err.message || "Error al verificar.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Verificar acceso";
    }
  }

  function mostrarModoOperador(email) {
    opEmail = email;
    document.getElementById("op-badge-email").textContent = email;
    document.getElementById("op-badge").classList.remove("hidden");
    document.getElementById("btn-operadores").classList.add("hidden");
    if (centroActivo) document.getElementById("op-panel-controles").classList.remove("hidden");
    document.body.classList.add("op-mode");
  }

  function cerrarSesionOperador() {
    opEmail = null;
    localStorage.removeItem(OP_SESSION_KEY);
    document.getElementById("op-badge").classList.add("hidden");
    document.getElementById("btn-operadores").classList.remove("hidden");
    document.getElementById("op-panel-controles").classList.add("hidden");
    document.body.classList.remove("op-mode");
    mostrarToast("Sesión de operador cerrada.", "info");
  }

  function initOperador() {
    try {
      const stored = localStorage.getItem(OP_SESSION_KEY);
      if (!stored) return;
      const session = JSON.parse(stored);
      if (!session || !session.email || !session.ts) return;
      const ttl = session.recordar ? OP_SESSION_LONG : OP_SESSION_TTL;
      if (Date.now() - session.ts > ttl) {
        localStorage.removeItem(OP_SESSION_KEY);
        return;
      }
      mostrarModoOperador(session.email);
    } catch (_) {
      localStorage.removeItem(OP_SESSION_KEY);
    }
  }

  async function opVerificarCentro() {
    if (!centroActivo || !opEmail) return;
    try {
      const res = await fetch(`${FIREBASE_CONFIG.databaseURL}/centros/${centroActivo}.json`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ verificado: true, actualizadoEn: Date.now() })
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg);
      }
      ultimaActualizacion = Date.now(); actualizarTimestamp();
      mostrarToast("Centro marcado como verificado ✓", "ok");
      await cargarDatos(false);
    } catch (e) {
      mostrarToast("Error al verificar: " + (e.message || "sin conexión"), "err");
    }
  }

  function opMostrarConfirmEliminar() {
    document.getElementById("op-confirm-eliminar").classList.remove("hidden");
    document.getElementById("btn-op-eliminar").classList.add("hidden");
  }

  function opCancelarEliminar() {
    document.getElementById("op-confirm-eliminar").classList.add("hidden");
    document.getElementById("btn-op-eliminar").classList.remove("hidden");
  }

  async function opEliminarCentro() {
    if (!centroActivo || !opEmail) return;
    const id = centroActivo;
    try {
      await API.eliminarCentro(id);
      cerrarPanel();
      opCancelarEliminar();
      ultimaActualizacion = Date.now(); actualizarTimestamp();
      mostrarToast("Centro eliminado.", "ok");
      await cargarDatos(false);
    } catch (_) {
      mostrarToast("Error al eliminar el centro.", "err");
      opCancelarEliminar();
    }
  }

  async function opLimpiarReportes() {
    if (!centroActivo || !opEmail) return;
    try {
      await fetch(`${FIREBASE_CONFIG.databaseURL}/centros/${centroActivo}/reportes.json`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(0)
      });
      const c = todosLosCentros.find(x => x.id === centroActivo);
      if (c) { c.reportes = 0; actualizarUI(); }
      ultimaActualizacion = Date.now(); actualizarTimestamp();
      mostrarToast("Reportes del centro limpiados.", "ok");
    } catch (_) {
      mostrarToast("Error al limpiar reportes.", "err");
    }
  }

  /* ══════════════════════════════════════════
     DEEPLINK ?id=
     ══════════════════════════════════════════ */
  function procesarDeeplink() {
    const id = new URLSearchParams(location.search).get("id");
    if (!id) return;
    let intentos = 0;
    const check = setInterval(() => {
      if (todosLosCentros.find(c => c.id === id)) {
        clearInterval(check);
        abrirPanel(id);
      }
      if (++intentos > 20) clearInterval(check);
    }, 300);
  }

  /* ══════════════════════════════════════════
     TIMESTAMP ÚLTIMA ACTUALIZACIÓN
     ══════════════════════════════════════════ */
  function actualizarTimestampDatos(centros) {
    const maxTs = centros.reduce((m, c) => Math.max(m, c.actualizadoEn || c.creadoEn || 0), 0);
    if (maxTs > 0) ultimaActualizacion = maxTs;
  }

  function actualizarTimestamp() {
    const el = document.getElementById("hstat-ts");
    if (!el || !ultimaActualizacion) return;
    const diff = Math.floor((Date.now() - ultimaActualizacion) / 1000);
    if (diff < 60)       el.textContent = "ahora";
    else if (diff < 3600) el.textContent = `${Math.floor(diff / 60)}min`;
    else                  el.textContent = `${Math.floor(diff / 3600)}h`;
  }

  /* ══════════════════════════════════════════
     ONLINE / OFFLINE
     ══════════════════════════════════════════ */
  function escucharConexion() {
    const banner = document.getElementById("offline-banner");
    const actualizar = () => {
      banner.classList.toggle("hidden", navigator.onLine);
      if (navigator.onLine) cargarDatos(false);
    };
    window.addEventListener("online",  actualizar);
    window.addEventListener("offline", actualizar);
    if (!navigator.onLine) banner.classList.remove("hidden");

    // Refrescar al volver a la app (móvil: cambio de app; desktop: cambio de pestaña)
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && navigator.onLine) cargarDatos(false);
    });
  }

  /* ══════════════════════════════════════════
     POBLAR SELECTS Y CHECKBOXES
     ══════════════════════════════════════════ */
  function poblarSelects() {
    ["filtro-estado", "qf-estado", "n-estado", "act-estado"].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      ESTADOS_VE.forEach(est => {
        const opt = document.createElement("option");
        opt.value = est; opt.textContent = est;
        sel.appendChild(opt);
      });
    });
  }

  function poblarCheckboxesInsumos() {
    [
      { id: "filtro-insumos", esFiltro: true },
      { id: "n-insumos",      esFiltro: false },
      { id: "act-insumos",    esFiltro: false }
    ].forEach(({ id, esFiltro }) => {
      const container = document.getElementById(id);
      TIPOS_INSUMO.forEach(tipo => {
        const label = document.createElement("label");
        label.className = "check-label";
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.value = tipo;
        if (esFiltro) {
          cb.addEventListener("change", () => {
            cb.checked ? filtros.insumos.add(tipo) : filtros.insumos.delete(tipo);
            actualizarUI();
          });
        }
        label.appendChild(cb);
        label.appendChild(document.createTextNode(tipo));
        container.appendChild(label);
      });
    });
  }

  /* ══════════════════════════════════════════
     EVENTOS
     ══════════════════════════════════════════ */
  function enlazarEventos() {
    // Sidebar
    document.getElementById("btn-filtros").addEventListener("click", toggleSidebar);
    document.getElementById("btn-cerrar-sidebar").addEventListener("click", cerrarSidebar);

    // Nuevo centro
    document.getElementById("btn-nuevo").addEventListener("click", abrirModalNuevo);
    document.getElementById("fab-nuevo").addEventListener("click", abrirModalNuevo);
    document.getElementById("btn-cerrar-nuevo").addEventListener("click", cerrarModalNuevo);
    document.getElementById("btn-cancelar-nuevo").addEventListener("click", cerrarModalNuevo);
    document.getElementById("backdrop-nuevo").addEventListener("click", cerrarModalNuevo);
    document.getElementById("form-nuevo").addEventListener("submit", submitNuevoCentro);
    document.getElementById("btn-mi-ubicacion").addEventListener("click", usarMiUbicacion);
    document.getElementById("btn-seleccionar-mapa").addEventListener("click", activarSeleccionUbicacion);
    document.getElementById("btn-cancelar-seleccion").addEventListener("click", cancelarSeleccionUbicacion);

    // Panel
    document.getElementById("btn-cerrar-panel").addEventListener("click", cerrarPanel);
    document.getElementById("btn-panel-actualizar").addEventListener("click", () => centroActivo && abrirModalActualizar(centroActivo));
    const panelShareBtn = document.getElementById("btn-panel-wa");
    if (navigator.share) {
      panelShareBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Compartir`;
      panelShareBtn.classList.remove("btn-wa");
    }
    panelShareBtn.addEventListener("click", () => centroActivo && compartirCentro(centroActivo));
    document.getElementById("btn-panel-qr").addEventListener("click",       () => centroActivo && mostrarQR(centroActivo));
    document.getElementById("btn-panel-reportar").addEventListener("click", () => centroActivo && reportarCentroProblema(centroActivo));

    // Actualizar
    document.getElementById("btn-cerrar-actualizar").addEventListener("click", cerrarModalActualizar);
    document.getElementById("btn-cancelar-actualizar").addEventListener("click", cerrarModalActualizar);
    document.getElementById("backdrop-actualizar").addEventListener("click", cerrarModalActualizar);
    document.getElementById("form-actualizar").addEventListener("submit", submitActualizarCentro);

    // Exportar / difundir
    document.getElementById("btn-exportar-csv").addEventListener("click", exportarCSV);
    document.getElementById("btn-exportar-pdf").addEventListener("click", exportarPDF);
    document.getElementById("btn-difundir-wa").addEventListener("click", abrirModalWA);
    document.getElementById("btn-cerrar-wa").addEventListener("click", cerrarModalWA);
    document.getElementById("backdrop-wa").addEventListener("click", cerrarModalWA);
    document.getElementById("btn-cerrar-qr").addEventListener("click", cerrarModalQR);
    document.getElementById("backdrop-qr").addEventListener("click", cerrarModalQR);
    document.getElementById("btn-sort-dist").addEventListener("click", toggleSortMode);
    document.getElementById("btn-toggle-satellite").addEventListener("click", () => {
      const tipo = MapaAcopio.toggleSatelite();
      document.getElementById("satellite-label").textContent = tipo === "satellite" ? "Mapa" : "Satélite";
    });

    // Búsqueda por nombre
    let debSearch;
    document.getElementById("buscar-centro").addEventListener("input", e => {
      clearTimeout(debSearch);
      debSearch = setTimeout(() => { buscarTexto = e.target.value.trim(); actualizarUI(); }, 250);
    });

    // Reintentar
    document.getElementById("btn-reintentar").addEventListener("click", () => {
      document.getElementById("error-state").classList.add("hidden");
      document.getElementById("loading-state").classList.remove("hidden");
      cargarDatos(true);
    });

    // Operadores
    document.getElementById("btn-operadores").addEventListener("click", abrirModalOperadores);
    document.getElementById("backdrop-op").addEventListener("click",    cerrarModalOperadores);
    document.getElementById("btn-cerrar-op").addEventListener("click",  cerrarModalOperadores);
    document.getElementById("btn-op-enviar").addEventListener("click",  enviarCodigoOperador);
    document.getElementById("btn-op-verificar-code").addEventListener("click", verificarCodigoOperador);
    document.getElementById("btn-op-volver").addEventListener("click", () => {
      document.getElementById("op-step-2").classList.add("hidden");
      document.getElementById("op-step-1").classList.remove("hidden");
      setTimeout(() => document.getElementById("op-email-input").focus(), 80);
    });
    document.getElementById("btn-op-logout").addEventListener("click", cerrarSesionOperador);
    document.getElementById("btn-op-verificar").addEventListener("click", opVerificarCentro);
    document.getElementById("btn-op-limpiar").addEventListener("click",   opLimpiarReportes);
    document.getElementById("op-foto-input").addEventListener("change", e => {
      const file = e.target.files?.[0];
      if (file) opAgregarFoto(file);
    });
    document.getElementById("btn-op-eliminar").addEventListener("click",        opMostrarConfirmEliminar);
    document.getElementById("btn-op-eliminar-ok").addEventListener("click",     opEliminarCentro);
    document.getElementById("btn-op-eliminar-cancel").addEventListener("click", opCancelarEliminar);

    // Enter en inputs del modal operador
    document.getElementById("op-email-input").addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); enviarCodigoOperador(); }
    });
    document.getElementById("op-code-input").addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); verificarCodigoOperador(); }
    });

    // Escape
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        cerrarModalNuevo(); cerrarModalActualizar(); cerrarPanel();
        cerrarModalOperadores(); cerrarModalAdmin(); cerrarModalQR();
      }
      // Atajo secreto admin: Ctrl + Shift + A
      if (e.ctrlKey && e.shiftKey && e.key === "A") {
        e.preventDefault();
        if (!opEmail) abrirModalAdmin();
      }
    });

    // Admin
    document.getElementById("btn-cerrar-admin").addEventListener("click",  cerrarModalAdmin);
    document.getElementById("backdrop-admin").addEventListener("click",     cerrarModalAdmin);
    document.getElementById("btn-admin-entrar").addEventListener("click",   verificarAdmin);
    document.getElementById("admin-pass-input").addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); verificarAdmin(); }
    });

    // Toque secreto en logo (móvil): 5 toques rápidos abren admin
    let logoTaps = 0, logoTimer = null;
    document.querySelector(".logo-wrap").addEventListener("click", () => {
      if (opEmail) return;
      logoTaps++;
      clearTimeout(logoTimer);
      logoTimer = setTimeout(() => { logoTaps = 0; }, 1500);
      if (logoTaps >= 5) { logoTaps = 0; abrirModalAdmin(); }
    });

    // Swipe-to-close panel en móvil
    (function () {
      const panel = document.getElementById("panel-centro");
      let startY = 0, startX = 0, dragging = false;
      panel.addEventListener("touchstart", e => {
        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
        dragging = true;
      }, { passive: true });
      panel.addEventListener("touchend", e => {
        if (!dragging) return;
        dragging = false;
        const dy = e.changedTouches[0].clientY - startY;
        const dx = e.changedTouches[0].clientX - startX;
        if (dy > 80 && Math.abs(dy) > Math.abs(dx) * 1.5) cerrarPanel();
      }, { passive: true });
    })();

    enlazarFiltros();
    iniciarAutocompleteDireccion();
  }

  /* ══════════════════════════════════════════
     UTILIDADES
     ══════════════════════════════════════════ */
  function getInsumosList(insumos) {
    if (Array.isArray(insumos)) return insumos;
    if (typeof insumos === "string") return insumos.split(",").map(s => s.trim()).filter(Boolean);
    return Object.values(insumos || {});
  }

  function normEstado(s) {
    return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  function setText(id, texto) {
    const el = document.getElementById(id);
    if (el) el.textContent = texto || "";
  }

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function mostrarLoadingSpinner(msg) {
    document.getElementById("loading-msg").textContent = msg || "Cargando...";
    document.getElementById("loading-state").classList.remove("hidden");
    document.getElementById("error-state").classList.add("hidden");
    document.getElementById("loading-overlay").style.display = "flex";
  }

  function ocultarLoading() {
    document.getElementById("loading-overlay").style.display = "none";
  }

  function mostrarErrorCarga(msg) {
    document.getElementById("error-msg").textContent = msg;
    document.getElementById("loading-state").classList.add("hidden");
    document.getElementById("error-state").classList.remove("hidden");
    document.getElementById("loading-overlay").style.display = "flex";
  }

  function mostrarToast(msg, tipo = "info") {
    const wrap  = document.getElementById("toast-wrap");
    const toast = document.createElement("div");
    toast.className = `toast${tipo === "ok" ? " toast-ok" : tipo === "err" ? " toast-err" : tipo === "warn" ? " toast-warn" : ""}`;
    toast.textContent = msg;
    wrap.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  function formatearTiempo(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (m < 1)  return "hace un momento";
    if (m < 60) return `hace ${m} min`;
    if (h < 24) return `hace ${h}h`;
    if (d === 1) return "ayer";
    return `hace ${d} días`;
  }

  /* API pública del módulo (para llamadas desde HTML generado) */
  return { init, abrirPanel };
})();

