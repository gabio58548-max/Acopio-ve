/**
 * ACOPIO VE — Módulo de mapa (Leaflet.js)
 */

const MapaAcopio = (() => {
  let mapa = null;
  let marcadores = {};        // id → L.Marker
  let marcadorTemp = null;    // marcador temporal al seleccionar ubicación
  let modoSeleccion = false;  // true cuando el usuario elige ubicación para nuevo centro
  let onClickMap = null;      // callback cuando el usuario hace clic en modo selección

  /* ── Color por capacidad ── */
  const COLORES = {
    disponible: { cls: "marker-verde",    dot: "dot-verde" },
    parcial:    { cls: "marker-amarillo", dot: "dot-amarillo" },
    lleno:      { cls: "marker-rojo",     dot: "dot-rojo" }
  };

  const LABELS = {
    disponible: "Disponible",
    parcial:    "Parcial",
    lleno:      "Lleno"
  };

  function colorPara(capacidad) {
    return COLORES[capacidad] || COLORES.parcial;
  }

  /* ── Crear icono personalizado ── */
  function crearIcono(capacidad) {
    const { cls } = colorPara(capacidad);
    return L.divIcon({
      className: "",
      html: `<div class="marker-icon ${cls}"></div>`,
      iconSize:   [28, 36],
      iconAnchor: [14, 36],
      popupAnchor:[0, -38]
    });
  }

  /* ── Popup HTML ── */
  function crearPopupHTML(centro) {
    const { cls: badgeCls } = colorPara(centro.capacidad);
    const label = LABELS[centro.capacidad] || centro.capacidad;
    return `
      <div class="popup-content">
        <div class="popup-nombre">${escHtml(centro.nombre)}</div>
        <div class="popup-dir">${escHtml(centro.direccion)}</div>
        <div class="popup-badge"><span class="badge ${badgeCls.replace('marker-','badge-')}">${label}</span></div>
        <button class="popup-btn" onclick="App.abrirPanel('${centro.id}')">Ver detalle</button>
      </div>
    `;
  }

  /* ── Escape HTML básico ── */
  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ── INIT ── */
  function init() {
    mapa = L.map("map", {
      center: VE_CENTER,
      zoom:   VE_ZOOM,
      zoomControl: true,
      attributionControl: true
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
      // Reduce tiles en señal débil con un subdominio
    }).addTo(mapa);

    mapa.on("click", (e) => {
      if (modoSeleccion && typeof onClickMap === "function") {
        onClickMap(e.latlng.lat, e.latlng.lng);
      }
    });

    // Cursor especial en modo selección
    mapa.getContainer().style.cursor = "";
  }

  /* ── Agregar o actualizar marcador ── */
  function upsertMarcador(centro) {
    const { lat, lng, id } = centro;
    if (!lat || !lng) return;

    if (marcadores[id]) {
      marcadores[id]
        .setLatLng([lat, lng])
        .setIcon(crearIcono(centro.capacidad))
        .setPopupContent(crearPopupHTML(centro));
    } else {
      const m = L.marker([lat, lng], { icon: crearIcono(centro.capacidad) })
        .bindPopup(crearPopupHTML(centro), { maxWidth: 240, minWidth: 180 })
        .addTo(mapa);
      m.on("click", () => {
        if (!modoSeleccion) App.abrirPanel(id);
      });
      marcadores[id] = m;
    }
  }

  /* ── Eliminar marcador ── */
  function quitarMarcador(id) {
    if (marcadores[id]) {
      mapa.removeLayer(marcadores[id]);
      delete marcadores[id];
    }
  }

  /* ── Sincronizar todos los centros ── */
  function sincronizarCentros(centros, filtrados) {
    const idsFiltrados = new Set(filtrados.map(c => c.id));

    // Asegurar marcadores para los filtrados
    for (const c of filtrados) {
      upsertMarcador(c);
      if (marcadores[c.id]) marcadores[c.id].setOpacity(1);
    }

    // Desvanecer los que no pasan el filtro pero mantenerlos para context
    for (const c of centros) {
      if (!idsFiltrados.has(c.id)) {
        if (marcadores[c.id]) marcadores[c.id].setOpacity(0.25);
      }
    }

    // Quitar marcadores de centros que ya no existen
    const idsActivos = new Set(centros.map(c => c.id));
    for (const id of Object.keys(marcadores)) {
      if (!idsActivos.has(id)) quitarMarcador(id);
    }
  }

  /* ── Volar a centro ── */
  function volarA(lat, lng, zoom = 15) {
    mapa.flyTo([lat, lng], zoom, { duration: 1 });
  }

  /* ── Abrir popup de un centro ── */
  function abrirPopup(id) {
    if (marcadores[id]) marcadores[id].openPopup();
  }

  /* ── Modo selección de ubicación ── */
  function activarSeleccion(callback) {
    modoSeleccion = true;
    onClickMap = callback;
    mapa.getContainer().style.cursor = "crosshair";
  }

  function desactivarSeleccion() {
    modoSeleccion = false;
    onClickMap = null;
    mapa.getContainer().style.cursor = "";
    quitarMarcadorTemp();
  }

  function ponerMarcadorTemp(lat, lng) {
    quitarMarcadorTemp();
    marcadorTemp = L.marker([lat, lng], {
      icon: L.divIcon({
        className: "",
        html: `<div class="marker-icon marker-verde" style="opacity:.8"></div>`,
        iconSize: [28, 36], iconAnchor: [14, 36]
      }),
      draggable: true
    }).addTo(mapa);

    marcadorTemp.on("dragend", e => {
      const { lat, lng } = e.target.getLatLng();
      if (typeof onClickMap === "function") onClickMap(lat, lng);
    });
  }

  function quitarMarcadorTemp() {
    if (marcadorTemp) { mapa.removeLayer(marcadorTemp); marcadorTemp = null; }
  }

  /* ── Centrar mapa en Venezuela ── */
  function centrarVenezuela() {
    mapa.setView(VE_CENTER, VE_ZOOM);
  }

  /* ── Cerrar todos los popups ── */
  function cerrarPopups() {
    mapa.closePopup();
  }

  /* ── Ajustar mapa a los centros filtrados ── */
  function ajustarVista(centros) {
    const conCoordenadas = centros.filter(c => c.lat && c.lng);
    if (conCoordenadas.length === 0) return;
    const bounds = L.latLngBounds(conCoordenadas.map(c => [c.lat, c.lng]));
    mapa.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  }

  return {
    init,
    upsertMarcador,
    quitarMarcador,
    sincronizarCentros,
    volarA,
    abrirPopup,
    activarSeleccion,
    desactivarSeleccion,
    ponerMarcadorTemp,
    centrarVenezuela,
    cerrarPopups,
    ajustarVista
  };
})();
