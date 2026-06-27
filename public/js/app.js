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
  let todosLosCentros = [];
  let centroActivo    = null;
  let desuscribirRT   = null;   // listener real-time
  let intervaloPolling = null;

  const filtros = {
    estado:    "",
    municipio: "",
    capacidad: new Set(["disponible","parcial","lleno"]),
    insumos:   new Set()
  };

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

    // 3. Cargar datos (con timeout y fallback a caché)
    await cargarDatos();

    // 4. Real-time en background (no bloquea el arranque)
    iniciarRealtime();

    // 5. Polling de respaldo (actualiza cada 60s si real-time no está activo)
    iniciarPolling();

    // 6. Deeplink
    procesarDeeplink();

    // 7. Service Worker
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(e =>
        console.warn("[SW] No registrado:", e)
      );
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
      actualizarUI();
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
      actualizarUI();
      // Cuando real-time está activo, el polling no hace falta
      if (intervaloPolling) {
        clearInterval(intervaloPolling);
        intervaloPolling = null;
      }
    });
  }

  /* ══════════════════════════════════════════
     POLLING — respaldo si real-time no conecta
     ══════════════════════════════════════════ */
  function iniciarPolling() {
    // El polling se detiene automáticamente si real-time conecta
    intervaloPolling = setInterval(async () => {
      if (desuscribirRT === null) return; // real-time no conectado: seguir polling
      // Si real-time está activo, limpiar el intervalo
      clearInterval(intervaloPolling);
      intervaloPolling = null;
    }, 1000);

    // Polling real cada 60 segundos
    const pollIntervalo = setInterval(async () => {
      // Si real-time ya está activo (desuscribirRT puede ser una función real)
      // El SDK llama callback directamente, así que si hay datos recientes no hace falta
      try {
        await cargarDatos(false);
      } catch (_) {}
    }, 60000);

    // Guardar referencia para poder limpiar
    intervaloPolling = pollIntervalo;
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
    return centros.filter(c => {
      if (filtros.estado    && c.estado !== filtros.estado) return false;
      if (filtros.municipio && !c.municipio.toLowerCase().includes(filtros.municipio.toLowerCase())) return false;
      if (!filtros.capacidad.has(c.capacidad)) return false;
      if (filtros.insumos.size > 0) {
        const insumosCentro = new Set(Array.isArray(c.insumos) ? c.insumos : Object.values(c.insumos || {}));
        if (![...filtros.insumos].some(i => insumosCentro.has(i))) return false;
      }
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

    setText("p-direccion", c.direccion || "—");
    setText("p-ubicacion", [c.municipio, c.estado].filter(Boolean).join(", ") || "—");

    const insumosEl = document.getElementById("p-insumos");
    insumosEl.innerHTML = "";
    const insumosList = Array.isArray(c.insumos) ? c.insumos : Object.values(c.insumos || {});
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
  }

  /* ══════════════════════════════════════════
     FORMULARIO: NUEVO CENTRO
     ══════════════════════════════════════════ */
  function abrirModalNuevo() {
    document.getElementById("form-nuevo").reset();
    document.getElementById("n-lat").value = "";
    document.getElementById("n-lng").value = "";
    document.getElementById("modal-nuevo").classList.remove("hidden");
  }

  function cerrarModalNuevo() {
    document.getElementById("modal-nuevo").classList.add("hidden");
    MapaAcopio.desactivarSeleccion();
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

    const data = {
      nombre:      document.getElementById("n-nombre").value,
      estado:      document.getElementById("n-estado").value,
      municipio:   document.getElementById("n-municipio").value,
      direccion:   document.getElementById("n-direccion").value,
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
      cerrarModalNuevo();
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

  function activarSeleccionUbicacion() {
    document.getElementById("loc-selecting-hint").classList.remove("hidden");
    const modal = document.getElementById("modal-nuevo");
    modal.style.pointerEvents = "none";
    modal.style.opacity = ".25";

    MapaAcopio.activarSeleccion((lat, lng) => {
      document.getElementById("n-lat").value = lat.toFixed(6);
      document.getElementById("n-lng").value = lng.toFixed(6);
      MapaAcopio.ponerMarcadorTemp(lat, lng);
      modal.style.pointerEvents = "";
      modal.style.opacity = "";
      document.getElementById("loc-selecting-hint").classList.add("hidden");
      MapaAcopio.desactivarSeleccion();
    });
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
        document.getElementById("n-lat").value = lat.toFixed(6);
        document.getElementById("n-lng").value = lng.toFixed(6);
        MapaAcopio.ponerMarcadorTemp(lat, lng);
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

    const insumosList = Array.isArray(c.insumos) ? c.insumos : Object.values(c.insumos || {});
    document.querySelectorAll("#act-insumos input").forEach(cb => {
      cb.checked = insumosList.includes(cb.value);
    });

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

    try {
      await API.actualizarCentro(id, {
        capacidad,
        insumos: insumos.length ? insumos : undefined,
        contacto: document.getElementById("act-contacto").value,
        notas:    document.getElementById("act-notas").value
      });
      cerrarModalActualizar();
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
  }

  function limpiarFiltros() {
    filtros.estado = ""; filtros.municipio = "";
    filtros.capacidad = new Set(["disponible","parcial","lleno"]);
    filtros.insumos = new Set();
    document.getElementById("filtro-estado").value = "";
    document.getElementById("filtro-municipio").value = "";
    document.querySelectorAll(".filtro-capacidad").forEach(cb => cb.checked = true);
    document.querySelectorAll("#filtro-insumos input").forEach(cb => cb.checked = false);
    actualizarUI();
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

    const sorted = [...centros].sort((a, b) => (b.actualizadoEn || 0) - (a.actualizadoEn || 0));
    container.innerHTML = sorted.map(c => {
      const dotCls  = { disponible:"dot-verde", parcial:"dot-amarillo", lleno:"dot-rojo" }[c.capacidad] || "dot-amarillo";
      return `
        <div class="lista-item" data-id="${c.id}" role="button" tabindex="0">
          <span class="lista-dot ${dotCls}"></span>
          <div class="lista-info">
            <div class="lista-nombre">${escHtml(c.nombre)}</div>
            <div class="lista-sub">${escHtml(c.municipio)}, ${escHtml(c.estado)}</div>
          </div>
        </div>`;
    }).join("");

    container.querySelectorAll(".lista-item").forEach(el => {
      el.addEventListener("click", () => { abrirPanel(el.dataset.id); cerrarSidebar(); });
      el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") abrirPanel(el.dataset.id); });
    });
  }

  function actualizarStats(filtrados) {
    document.getElementById("stat-total").textContent       = filtrados.length;
    document.getElementById("stat-disponibles").textContent = filtrados.filter(c => c.capacidad === "disponible").length;
    document.getElementById("stat-parciales").textContent   = filtrados.filter(c => c.capacidad === "parcial").length;
    document.getElementById("stat-llenos").textContent      = filtrados.filter(c => c.capacidad === "lleno").length;
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
  function compartir(id) {
    const c = todosLosCentros.find(x => x.id === id);
    if (!c) return;
    const url   = `${location.origin}${location.pathname}?id=${id}`;
    const texto = `Centro de Acopio: ${c.nombre}\n${c.direccion}, ${c.municipio}, ${c.estado}\nEstado: ${c.capacidad}\n${url}`;
    if (navigator.share) {
      navigator.share({ title: c.nombre, text: texto, url }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(texto).then(() => mostrarToast("Información copiada.", "ok"))
        .catch(() => mostrarToast("URL: " + url, "info"));
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
  }

  /* ══════════════════════════════════════════
     POBLAR SELECTS Y CHECKBOXES
     ══════════════════════════════════════════ */
  function poblarSelects() {
    [document.getElementById("filtro-estado"), document.getElementById("n-estado")].forEach(sel => {
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
    document.getElementById("loc-selecting-hint").addEventListener("click", activarSeleccionUbicacion);

    // Panel
    document.getElementById("btn-cerrar-panel").addEventListener("click", cerrarPanel);
    document.getElementById("btn-panel-actualizar").addEventListener("click", () => centroActivo && abrirModalActualizar(centroActivo));
    document.getElementById("btn-panel-compartir").addEventListener("click",  () => centroActivo && compartir(centroActivo));

    // Actualizar
    document.getElementById("btn-cerrar-actualizar").addEventListener("click", cerrarModalActualizar);
    document.getElementById("btn-cancelar-actualizar").addEventListener("click", cerrarModalActualizar);
    document.getElementById("backdrop-actualizar").addEventListener("click", cerrarModalActualizar);
    document.getElementById("form-actualizar").addEventListener("submit", submitActualizarCentro);

    // Reintentar
    document.getElementById("btn-reintentar").addEventListener("click", () => {
      document.getElementById("error-state").classList.add("hidden");
      document.getElementById("loading-state").classList.remove("hidden");
      cargarDatos(true);
    });

    // Escape
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { cerrarModalNuevo(); cerrarModalActualizar(); cerrarPanel(); }
    });

    enlazarFiltros();
  }

  /* ══════════════════════════════════════════
     UTILIDADES
     ══════════════════════════════════════════ */
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

document.addEventListener("DOMContentLoaded", App.init);
