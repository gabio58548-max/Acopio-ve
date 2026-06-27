/**
 * ACOPIO VE — Configuración de Firebase
 *
 * INSTRUCCIONES:
 * 1. Ve a https://console.firebase.google.com
 * 2. Crea un proyecto (o usa uno existente)
 * 3. Ve a Configuración del proyecto → Tus apps → Agrega app web
 * 4. Copia los valores aquí
 * 5. Activa Firebase Realtime Database en modo prueba
 */

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyA10E_23zpeXs81nkGcrBaisw7fev-McG8",
  authDomain:        "acopio-ve-2026.firebaseapp.com",
  databaseURL:       "https://acopio-ve-2026-default-rtdb.firebaseio.com",
  projectId:         "acopio-ve-2026",
  storageBucket:     "acopio-ve-2026.firebasestorage.app",
  messagingSenderId: "114921181367",
  appId:             "1:114921181367:web:7ee9f567bb7084ab627d32"
};

/* ────────────────────────────────────────────────
   API REST pública de Firebase Realtime Database
   ────────────────────────────────────────────────
   Base URL: https://acopio-ve-2026-default-rtdb.firebaseio.com

   GET    /centros.json                              → Todos los centros
   GET    /centros/{id}.json                         → Centro específico
   POST   /centros.json          + body JSON          → Crear (devuelve {name: id})
   PATCH  /centros/{id}.json     + body JSON          → Actualizar parcialmente
   PUT    /centros/{id}.json     + body JSON          → Reemplazar completo
   DELETE /centros/{id}.json                         → Eliminar

   Filtro por estado (requiere índice .indexOn en reglas):
   GET /centros.json?orderBy="estado"&equalTo="Aragua"

   Para escritura con auth (modo seguro):
   Agrega ?auth=TOKEN a cualquier URL de escritura.
   Genera el token con Firebase Auth o con el Admin SDK.
   ──────────────────────────────────────────────── */

/* Tipos de insumos aceptados */
const TIPOS_INSUMO = [
  "Agua potable",
  "Alimentos no perecederos",
  "Medicamentos",
  "Ropa y calzado",
  "Artículos de higiene",
  "Frazadas y colchonetas",
  "Materiales de construcción",
  "Equipos médicos",
  "Herramientas",
  "Combustible",
  "Artículos para bebés",
  "Sillas de ruedas / movilidad",
  "Linternas / velas",
  "Otros"
];

/* Estados de Venezuela */
const ESTADOS_VE = [
  "Amazonas", "Anzoátegui", "Apure", "Aragua", "Barinas",
  "Bolívar", "Carabobo", "Cojedes", "Delta Amacuro",
  "Distrito Capital", "Falcón", "Guárico", "La Guaira (Vargas)",
  "Lara", "Mérida", "Miranda", "Monagas", "Nueva Esparta",
  "Portuguesa", "Sucre", "Táchira", "Trujillo", "Yaracuy", "Zulia"
];

/* Centro geográfico de Venezuela + zoom inicial */
const VE_CENTER = [8.0, -66.5];
const VE_ZOOM   = 6;
