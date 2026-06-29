/**
 * ACOPIO VE — Módulo de mapa (MapLibre GL JS)
 *
 * Renderizado: capas GeoJSON nativas (GPU) + clustering automático.
 * Los marcadores DOM individuales se eliminaron — soporta miles de puntos.
 */

const MapaAcopio = (() => {
  let mapa           = null;
  let centrosMap     = {};      // id → centro completo
  let filtradosIds   = new Set();
  let marcadorTemp   = null;
  let popupActual    = null;
  let modoSeleccion  = false;
  let onClickMap     = null;
  let esSatelite     = false;
  let capasListas    = false;

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

  const VE_LNG_LAT = [VE_CENTER[1], VE_CENTER[0]];

  const STYLE_MAPA = "https://tiles.openfreemap.org/styles/bright";
  const STYLE_SAT  = {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      esri: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256, maxzoom: 19,
        attribution: "© Esri, Maxar, Earthstar Geographics"
      }
    },
    layers: [{ id: "esri-sat", type: "raster", source: "esri" }]
  };

  /* ── GeoJSON helpers ── */
  function vacio() { return { type: "FeatureCollection", features: [] }; }

  function toFeature(c) {
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lng, c.lat] },
      properties: {
        id:        c.id,
        nombre:    c.nombre    || "",
        estado:    c.estado    || "",
        municipio: c.municipio || "",
        direccion: c.direccion || "",
        capacidad: c.capacidad || "parcial",
        contacto:  c.contacto  || "",
        horario:   c.horario   || ""
      }
    };
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
      <button class="popup-btn" onclick="App.abrirPanel('${escHtml(centro.id)}')">Ver detalle completo →</button>
    </div>`;
  }

  /* ── Añadir fuentes y capas al mapa ── */
  function aplicarCapas() {
    if (!mapa) return;

    // Limpiar si ya existían (toggle satélite reconstruye todo)
    ["clusters","cluster-count","punto-activo","punto-dim"].forEach(id => {
      try { if (mapa.getLayer(id)) mapa.removeLayer(id); } catch (_) {}
    });
    ["centros-active","centros-dim"].forEach(id => {
      try { if (mapa.getSource(id)) mapa.removeSource(id); } catch (_) {}
    });

    // Fuente principal: centros filtrados con clustering
    mapa.addSource("centros-active", {
      type: "geojson",
      data: vacio(),
      cluster: true,
      clusterMaxZoom: 11,
      clusterRadius: 50
    });

    // Fuente secundaria: centros NO filtrados (sin clustering)
    mapa.addSource("centros-dim", {
      type: "geojson",
      data: vacio()
    });

    // Capa 1: puntos opacos (no filtrados)
    try {
      mapa.addLayer({
        id: "punto-dim",
        type: "circle",
        source: "centros-dim",
        paint: {
          "circle-radius": 5,
          "circle-color": "#999999",
          "circle-opacity": 0.18,
          "circle-stroke-width": 0
        }
      });
    } catch (_) {}

    // Capa 2: burbujas de cluster
    try {
      mapa.addLayer({
        id: "clusters",
        type: "circle",
        source: "centros-active",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "step", ["get", "point_count"],
            "#27AE60", 15, "#F39C12", 40, "#E74C3C"
          ],
          "circle-radius": [
            "step", ["get", "point_count"],
            22, 15, 30, 40, 38
          ],
          "circle-stroke-width": 3,
          "circle-stroke-color": "rgba(255,255,255,0.35)"
        }
      });
    } catch (_) {}

    // Capa 3: número dentro del cluster
    try {
      mapa.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "centros-active",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 13
        },
        paint: {
          "text-color": "#ffffff"
        }
      });
    } catch (_) {}

    // Capa 4: puntos individuales (sin cluster) — crítica
    try {
      mapa.addLayer({
        id: "punto-activo",
        type: "circle",
        source: "centros-active",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            8, 6,
            14, 10
          ],
          "circle-color": [
            "match", ["get", "capacidad"],
            "disponible", "#27AE60",
            "parcial",    "#F39C12",
            "lleno",      "#E74C3C",
            "#F39C12"
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff"
        }
      });
    } catch (_) {}

    /* ── Interacciones ── */
    mapa.on("click", "clusters", async e => {
      const feat = mapa.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
      if (!feat) return;
      try {
        const zoom = await mapa.getSource("centros-active").getClusterExpansionZoom(feat.properties.cluster_id);
        mapa.easeTo({ center: feat.geometry.coordinates, zoom: zoom + 0.5, duration: 400 });
      } catch (_) {}
    });

    mapa.on("click", "punto-activo", e => {
      if (modoSeleccion) return;
      const id     = e.features[0].properties.id;
      const coords = e.features[0].geometry.coordinates.slice();
      mostrarPopup(id, coords);
      App.abrirPanel(id);
    });

    mapa.on("mouseenter", "clusters",     () => { mapa.getCanvas().style.cursor = "pointer"; });
    mapa.on("mouseleave", "clusters",     () => { if (!modoSeleccion) mapa.getCanvas().style.cursor = ""; });
    mapa.on("mouseenter", "punto-activo", () => { mapa.getCanvas().style.cursor = "pointer"; });
    mapa.on("mouseleave", "punto-activo", () => { if (!modoSeleccion) mapa.getCanvas().style.cursor = ""; });

    capasListas = true;
    actualizarFuente();
  }

  /* ── Actualizar datos en las fuentes GeoJSON ── */
  function actualizarFuente() {
    if (!capasListas || !mapa) return;
    const todos   = Object.values(centrosMap);
    const activos = todos.filter(c => filtradosIds.has(c.id) && c.lat && c.lng);
    const opacos  = todos.filter(c => !filtradosIds.has(c.id) && c.lat && c.lng);
    mapa.getSource("centros-active").setData({ type: "FeatureCollection", features: activos.map(toFeature) });
    mapa.getSource("centros-dim").setData({ type: "FeatureCollection", features: opacos.map(toFeature) });
  }

  /* ── Popup ── */
  function mostrarPopup(id, lngLat) {
    if (popupActual) { popupActual.remove(); popupActual = null; }
    const centro = centrosMap[id];
    if (!centro) return;
    popupActual = new maplibregl.Popup({ offset: 14, maxWidth: "300px", closeOnClick: false })
      .setLngLat(lngLat)
      .setHTML(crearPopupHTML(centro))
      .addTo(mapa);
    popupActual.on("close", () => { popupActual = null; });
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

    mapa.on("load",       () => aplicarCapas());
    mapa.on("style.load", () => { capasListas = false; aplicarCapas(); });

    mapa.on("click", e => {
      if (modoSeleccion && typeof onClickMap === "function") {
        onClickMap(e.lngLat.lat, e.lngLat.lng);
      }
    });
  }

  /* ── API pública ── */

  function sincronizarCentros(centros, filtrados) {
    centrosMap   = {};
    centros.forEach(c => { centrosMap[c.id] = c; });
    filtradosIds = new Set(filtrados.map(c => c.id));
    actualizarFuente();
  }

  function upsertMarcador(centro) {
    centrosMap[centro.id] = centro;
  }

  function quitarMarcador(id) {
    delete centrosMap[id];
  }

  function abrirPopup(id) {
    const c = centrosMap[id];
    if (!c || !c.lat || !c.lng) return;
    mostrarPopup(id, [c.lng, c.lat]);
  }

  function volarA(lat, lng, zoom = 15) {
    mapa.flyTo({ center: [lng, lat], zoom, duration: 800 });
  }

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

  function crearElMarcadorDOM(cap) {
    const c  = COLORES[cap] || COLORES.parcial;
    const el = document.createElement("div");
    el.className = "mbx-pin";
    el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 0C6.27 0 0 6.27 0 14c0 9.33 14 22 14 22S28 23.33 28 14C28 6.27 21.73 0 14 0z" fill="${c}"/>
      <circle cx="14" cy="14" r="5.5" fill="white"/>
    </svg>`;
    return el;
  }

  function ponerMarcadorTemp(lat, lng, onDrag) {
    quitarMarcadorTemp();
    const el = crearElMarcadorDOM("disponible");
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

  function centrarVenezuela() {
    mapa.flyTo({ center: VE_LNG_LAT, zoom: VE_ZOOM - 1 });
  }

  function toggleSatelite() {
    if (!mapa) return;
    mapa.setStyle(esSatelite ? STYLE_MAPA : STYLE_SAT);
    esSatelite = !esSatelite;
    return esSatelite ? "satellite" : "roadmap";
  }

  function cerrarPopups() {
    if (popupActual) { popupActual.remove(); popupActual = null; }
  }

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
