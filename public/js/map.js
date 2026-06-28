/**
 * ACOPIO VE — Módulo de mapa (MapLibre GL JS — API compatible con Mapbox, sin API key)
 * Tiles: OpenFreeMap (vectoriales, gratuitos, sin registro)
 * Satélite: ESRI World Imagery (gratuito, sin registro)
 */

const MapaAcopio = (() => {
  let mapa        = null;
  let marcadores  = {};   // id → { marker, el, centro }
  let marcadorTemp = null;
  let popupActual  = null;
  let modoSeleccion = false;
  let onClickMap    = null;
  let esSatelite    = false;

  const COLORES = {
    disponible: "#27AE60",
    parcial:    "#F39C12",
    lleno:      "#E74C3C"
  };
  const LABELS = {
    disponible: "Disponible",
    parcial:    "Parcial",
    lleno:      "Lleno"
  };

  // MapLibre usa [lng, lat]; VE_CENTER del config.js es [lat, lng]
  const VE_LNG_LAT = [VE_CENTER[1], VE_CENTER[0]];

  const STYLE_MAPA = "https://tiles.openfreemap.org/styles/bright";

  const STYLE_SAT = {
    version: 8,
    sources: {
      esri: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© Esri, Maxar, Earthstar Geographics"
      }
    },
    layers: [{ id: "esri-sat", type: "raster", source: "esri" }]
  };

  function colorPara(cap) { return COLORES[cap] || COLORES.parcial; }

  /* ── Elemento DOM del marcador (pin SVG) ── */
  function crearElMarcador(cap, opacidad = 1) {
    const c = colorPara(cap);
    const el = document.createElement("div");
    el.className = "mbx-pin";
    el.style.opacity = opacidad;
    el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 0C6.27 0 0 6.27 0 14c0 9.33 14 22 14 22S28 23.33 28 14C28 6.27 21.73 0 14 0z" fill="${c}"/>
      <circle cx="14" cy="14" r="5.5" fill="white"/>
    </svg>`;
    return el;
  }

  /* ── Escape HTML ── */
  function escHtml(str) {
    return String(str || "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  /* ── Popup HTML ── */
  function crearPopupHTML(centro) {
    const badgeCls = { disponible:"badge-verde", parcial:"badge-amarillo", lleno:"badge-rojo" }[centro.capacidad] || "badge-amarillo";
    const label    = LABELS[centro.capacidad] || centro.capacidad;
    const lista    = Array.isArray(centro.insumos) ? centro.insumos : Object.values(centro.insumos || {});
    const vis      = lista.slice(0, 4);
    const rest     = lista.length - vis.length;
    const insumosHTML = vis.length
      ? `<div class="popup-insumos">
           ${vis.map(i => `<span class="popup-tag">${escHtml(i)}</span>`).join("")}
           ${rest > 0 ? `<span class="popup-tag popup-tag-more">+${rest}</span>` : ""}
         </div>` : "";
    const contactoHTML = centro.contacto
      ? `<div class="popup-contacto"><span class="popup-ic">📞</span>${escHtml(centro.contacto)}</div>` : "";
    const horarioHTML = centro.horario
      ? `<div class="popup-contacto"><span class="popup-ic">🕐</span>${escHtml(centro.horario)}</div>` : "";
    return `<div class="popup-content">
      <div class="popup-header">
        <span class="badge ${badgeCls}">${label}</span>
        <span class="popup-ubicacion">${escHtml(centro.municipio)}, ${escHtml(centro.estado)}</span>
      </div>
      <div class="popup-nombre">${escHtml(centro.nombre)}</div>
      <div class="popup-dir">${escHtml(centro.direccion)}</div>
      ${insumosHTML}${contactoHTML}${horarioHTML}
      <button class="popup-btn" onclick="App.abrirPanel('${centro.id}')">Ver detalle completo →</button>
    </div>`;
  }

  /* ── INIT ── */
  function init() {
    mapa = new maplibregl.Map({
      container: "map",
      style:     STYLE_MAPA,
      center:    VE_LNG_LAT,
      zoom:      VE_ZOOM - 1,
      attributionControl: { compact: true }
    });

    mapa.on("click", e => {
      if (modoSeleccion && typeof onClickMap === "function") {
        onClickMap(e.lngLat.lat, e.lngLat.lng);
      }
    });
  }

  /* ── Agregar / actualizar marcador ── */
  function upsertMarcador(centro) {
    const { lat, lng, id } = centro;
    if (!lat || !lng) return;

    if (marcadores[id]) {
      marcadores[id].marker.setLngLat([lng, lat]);
      // Actualizar color del pin
      const pathEl = marcadores[id].el.querySelector("path");
      if (pathEl) pathEl.setAttribute("fill", colorPara(centro.capacidad));
      marcadores[id].el.style.opacity = 1;
      marcadores[id].centro = centro;
    } else {
      const el = crearElMarcador(centro.capacidad);
      const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([lng, lat])
        .addTo(mapa);

      el.addEventListener("click", e => {
        if (modoSeleccion) return;
        e.stopPropagation();
        abrirPopupMarcador(id);
        App.abrirPanel(id);
      });

      marcadores[id] = { marker, el, centro };
    }
  }

  /* ── Abrir popup al hacer click en un marcador ── */
  function abrirPopupMarcador(id) {
    if (!marcadores[id]) return;
    if (popupActual) { popupActual.remove(); popupActual = null; }
    const { centro, marker } = marcadores[id];
    const lngLat = marker.getLngLat();
    popupActual = new maplibregl.Popup({ offset: [0, -38], maxWidth: "300px", closeOnClick: false })
      .setLngLat(lngLat)
      .setHTML(crearPopupHTML(centro))
      .addTo(mapa);
    popupActual.on("close", () => { popupActual = null; });
  }

  /* ── Eliminar marcador ── */
  function quitarMarcador(id) {
    if (marcadores[id]) {
      marcadores[id].marker.remove();
      delete marcadores[id];
    }
  }

  /* ── Sincronizar todos los centros ── */
  function sincronizarCentros(centros, filtrados) {
    const idsFiltrados = new Set(filtrados.map(c => c.id));

    for (const c of filtrados) {
      upsertMarcador(c);
      if (marcadores[c.id]) marcadores[c.id].el.style.opacity = 1;
    }
    for (const c of centros) {
      if (!idsFiltrados.has(c.id) && marcadores[c.id]) {
        marcadores[c.id].el.style.opacity = 0.3;
      }
    }
    const idsActivos = new Set(centros.map(c => c.id));
    for (const id of Object.keys(marcadores)) {
      if (!idsActivos.has(id)) quitarMarcador(id);
    }
  }

  /* ── Volar a coordenadas ── */
  function volarA(lat, lng, zoom = 15) {
    mapa.flyTo({ center: [lng, lat], zoom, duration: 800 });
  }

  /* ── Abrir popup de un centro específico ── */
  function abrirPopup(id) {
    abrirPopupMarcador(id);
  }

  /* ── Modo selección de ubicación ── */
  function activarSeleccion(callback) {
    modoSeleccion = true;
    onClickMap    = callback;
    mapa.getCanvas().style.cursor = "crosshair";
  }

  function desactivarSeleccion() {
    modoSeleccion = false;
    onClickMap    = null;
    mapa.getCanvas().style.cursor = "";
  }

  /* ── Marcador temporal arrastrable ── */
  function ponerMarcadorTemp(lat, lng, onDrag) {
    quitarMarcadorTemp();
    const el = crearElMarcador("disponible");
    marcadorTemp = new maplibregl.Marker({ element: el, anchor: "bottom", draggable: true })
      .setLngLat([lng, lat])
      .addTo(mapa);
    if (typeof onDrag === "function") {
      marcadorTemp.on("dragend", () => {
        const pos = marcadorTemp.getLngLat();
        onDrag(pos.lat, pos.lng);
      });
    }
  }

  function quitarMarcadorTemp() {
    if (marcadorTemp) { marcadorTemp.remove(); marcadorTemp = null; }
  }

  /* ── Centrar en Venezuela ── */
  function centrarVenezuela() {
    mapa.flyTo({ center: VE_LNG_LAT, zoom: VE_ZOOM - 1 });
  }

  /* ── Toggle mapa / satélite ── */
  function toggleSatelite() {
    if (!mapa) return;
    // Los marcadores HTML sobreviven al cambio de estilo (son DOM overlay, no WebGL)
    mapa.setStyle(esSatelite ? STYLE_MAPA : STYLE_SAT);
    esSatelite = !esSatelite;
    return esSatelite ? "satellite" : "roadmap";
  }

  /* ── Cerrar popup activo ── */
  function cerrarPopups() {
    if (popupActual) { popupActual.remove(); popupActual = null; }
  }

  /* ── Ajustar vista a centros filtrados ── */
  function ajustarVista(centros) {
    const con = centros.filter(c => c.lat && c.lng);
    if (!con.length) return;
    const b = con.reduce((acc, c) => ({
      minLng: Math.min(acc.minLng, c.lng), maxLng: Math.max(acc.maxLng, c.lng),
      minLat: Math.min(acc.minLat, c.lat), maxLat: Math.max(acc.maxLat, c.lat)
    }), { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity });
    mapa.fitBounds([[b.minLng, b.minLat], [b.maxLng, b.maxLat]], { padding: 60 });
  }

  return {
    init, upsertMarcador, quitarMarcador, sincronizarCentros,
    volarA, abrirPopup, activarSeleccion, desactivarSeleccion,
    ponerMarcadorTemp, quitarMarcadorTemp, centrarVenezuela,
    cerrarPopups, ajustarVista, toggleSatelite
  };
})();
