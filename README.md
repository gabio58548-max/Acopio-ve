# 🏚️ Acopio VE — Centros de Acopio Venezuela

Mapa colaborativo en tiempo real para coordinar centros de acopio post-terremoto en Venezuela.  
Open source, liviano, funciona con señal débil, pensado para emergencias sísmicas.

---

## Demo

> **URL en producción:** https://acopio-ve-2026.web.app

---

## Características

- **Mapa interactivo** (Leaflet.js + OpenStreetMap) con marcadores por capacidad
- **Semáforo visual**: 🟢 Disponible / 🟡 Parcial / 🔴 Lleno
- **Registro de nuevos centros** — formulario público con GPS o clic en mapa
- **Actualización de estado** en tiempo real (Firebase Realtime Database)
- **Filtros**: por estado, municipio, capacidad y tipo de insumo
- **Panel de detalle**: dirección, contacto, horario, insumos, última actualización
- **Compartir por WhatsApp/Telegram** con un clic
- **PWA**: instalable en móvil, funciona offline con datos en caché
- **API REST** documentada (Firebase RTDB nativo)

---

## Stack Tecnológico

| Capa | Tecnología |
|------|-----------|
| Frontend | HTML5 + CSS3 + JavaScript vanilla |
| Mapa | [Leaflet.js 1.9.4](https://leafletjs.com) + OpenStreetMap |
| Base de datos | Firebase Realtime Database |
| Hosting | Firebase Hosting |
| Offline | Service Worker (Cache API) |

---

## Estructura del Proyecto

```
acopio-ve/
├── public/
│   ├── index.html          # SPA principal
│   ├── css/
│   │   └── style.css       # Todos los estilos (mobile-first)
│   ├── js/
│   │   ├── config.js       # ⚠️ Configuración Firebase (editar aquí)
│   │   ├── api.js          # Wrapper sobre Firebase RTDB + REST
│   │   ├── map.js          # Lógica del mapa (Leaflet)
│   │   └── app.js          # Orquestador principal
│   ├── icons/
│   │   ├── icon.svg        # Ícono fuente
│   │   ├── icon-192.png    # Ícono PWA (generar con generar-iconos.html)
│   │   ├── icon-512.png    # Ícono PWA grande
│   │   └── generar-iconos.html  # Herramienta para generar PNGs
│   ├── manifest.json       # Manifiesto PWA
│   └── sw.js               # Service Worker
├── database.rules.json     # Reglas de seguridad Firebase RTDB
├── firebase.json           # Configuración Firebase Hosting
├── .firebaserc             # Proyecto Firebase activo
├── datos-ejemplo.json      # Datos de prueba para importar
└── README.md
```

---

## Instalación y Deploy

### Requisitos

- Cuenta de Google
- Node.js 18+ (solo para instalar Firebase CLI)
- Proyecto en [Firebase Console](https://console.firebase.google.com)

### Paso 1 — Crear proyecto Firebase

1. Ve a [console.firebase.google.com](https://console.firebase.google.com)
2. Crea un nuevo proyecto (ej: `acopio-ve-2026`)
3. En **Realtime Database** → Crear base de datos → Modo prueba
4. En **Hosting** → Comenzar

### Paso 2 — Configurar la app

Edita `public/js/config.js` con los datos de tu proyecto:

```js
const FIREBASE_CONFIG = {
  apiKey:            "AIza...",
  authDomain:        "acopio-ve-2026.firebaseapp.com",
  databaseURL:       "https://acopio-ve-2026-default-rtdb.firebaseio.com",
  projectId:         "acopio-ve-2026",
  storageBucket:     "acopio-ve-2026.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123"
};
```

Los valores los encuentras en:  
**Firebase Console → Configuración del proyecto → Tus apps → App web (agrega una si no tienes)**

### Paso 3 — Generar íconos PWA

Abre `public/icons/generar-iconos.html` en tu navegador y descarga los dos PNGs.  
Cópialos a `public/icons/`.

### Paso 4 — Instalar Firebase CLI y hacer deploy

```bash
npm install -g firebase-tools
firebase login
firebase use --add   # selecciona tu proyecto
firebase deploy --only hosting,database
```

### Paso 5 — Importar datos de ejemplo (opcional)

```bash
firebase database:set /centros datos-ejemplo.json --project TU_PROYECTO_ID
# o desde Firebase Console → Realtime Database → Importar JSON
```

---

## API REST Documentada

La API REST es la que provee Firebase Realtime Database de forma nativa.

**Base URL:** `https://acopio-ve-2026-default-rtdb.firebaseio.com`

---

### `GET /centros.json`
Devuelve todos los centros de acopio.

```bash
curl https://acopio-ve-2026-default-rtdb.firebaseio.com/centros.json
```

**Respuesta:**
```json
{
  "-NxABC123": {
    "nombre": "Centro El Limón",
    "estado": "Aragua",
    "municipio": "Mario Briceño Iragorry",
    "direccion": "Av. Bolívar...",
    "lat": 10.3022,
    "lng": -67.6265,
    "capacidad": "disponible",
    "insumos": ["Agua potable", "Alimentos no perecederos"],
    "contacto": "+58 424 4561234",
    "responsable": "Cruz Roja Aragua",
    "horario": "7am-7pm",
    "notas": "...",
    "creadoEn": 1750982400000,
    "actualizadoEn": 1750982400000
  }
}
```

---

### `GET /centros/{id}.json`
Devuelve un centro específico por su ID.

```bash
curl https://acopio-ve-2026-default-rtdb.firebaseio.com/centros/-NxABC123.json
```

---

### `GET /centros.json?orderBy="estado"&equalTo="Aragua"`
Filtra centros por estado (requiere que el índice esté en las reglas — ya incluido en `database.rules.json`).

```bash
curl 'https://acopio-ve-2026-default-rtdb.firebaseio.com/centros.json?orderBy="estado"&equalTo="Aragua"'
```

---

### `POST /centros.json`
Registra un nuevo centro. Firebase genera un ID automáticamente.

```bash
curl -X POST \
  https://acopio-ve-2026-default-rtdb.firebaseio.com/centros.json \
  -H "Content-Type: application/json" \
  -d '{
    "nombre": "Centro Nuevo",
    "estado": "Carabobo",
    "municipio": "Valencia",
    "direccion": "Av. Lara, Urb. La Viña",
    "lat": 10.1620,
    "lng": -67.9937,
    "capacidad": "disponible",
    "insumos": ["Agua potable", "Alimentos no perecederos"],
    "contacto": "+58 424 1234567",
    "responsable": "Alcaldía Valencia",
    "actualizadoEn": 1750982400000,
    "creadoEn": 1750982400000
  }'
```

**Respuesta:**
```json
{ "name": "-NxNEWID123" }
```

---

### `PATCH /centros/{id}.json`
Actualiza campos específicos de un centro (no reemplaza el documento completo).

```bash
curl -X PATCH \
  https://acopio-ve-2026-default-rtdb.firebaseio.com/centros/-NxABC123.json \
  -H "Content-Type: application/json" \
  -d '{
    "capacidad": "lleno",
    "notas": "Capacidad máxima alcanzada a las 3pm.",
    "actualizadoEn": 1750995600000
  }'
```

---

## Esquema de Datos

```typescript
interface Centro {
  nombre:        string;        // Nombre del centro
  estado:        string;        // Estado de Venezuela
  municipio:     string;        // Municipio
  direccion:     string;        // Dirección completa
  lat:           number;        // Latitud (-90 a 90)
  lng:           number;        // Longitud (-180 a 180)
  capacidad:     "disponible" | "parcial" | "lleno";
  insumos:       string[];      // Ver lista en config.js
  contacto?:     string;        // Teléfono u otro contacto
  responsable?:  string;        // Organización responsable
  horario?:      string;        // Horario de atención
  notas?:        string;        // Notas libres (máx 500 chars)
  creadoEn:      number;        // Unix timestamp (ms)
  actualizadoEn: number;        // Unix timestamp (ms)
}
```

---

## Seguridad

### Modo emergencia (por defecto)
Las reglas en `database.rules.json` permiten **lectura pública** y **escritura pública con validación de esquema**.  
Esto es intencional para el contexto de emergencia donde múltiples organizaciones deben contribuir rápidamente.

### Modo post-emergencia (recomendado)
Para cerrar la escritura a usuarios autenticados, cambia en `database.rules.json`:

```json
"$centroId": {
  ".write": "auth != null",
  ...
}
```

Y activa Firebase Authentication en la consola. Las opciones más simples:
- **Email/contraseña** con cuentas para organizaciones oficiales
- **Google Sign-In** para voluntarios con Google
- **Anónimo** para cualquier usuario (trazabilidad sin registro)

---

## Variables de entorno

No se requieren variables de entorno. Toda la configuración está en `public/js/config.js`.

---

## Contribuir

1. Fork del repositorio
2. Crea tu rama: `git checkout -b feature/mi-mejora`
3. Commit: `git commit -m "Agrega X"`
4. Push: `git push origin feature/mi-mejora`
5. Abre un Pull Request

---

## Licencia

MIT License — Libre para uso, modificación y distribución.  
Hecho con urgencia y cariño para Venezuela. 🇻🇪

---

## Créditos

- Cartografía: [OpenStreetMap](https://openstreetmap.org) contributors
- Mapa: [Leaflet.js](https://leafletjs.com)
- Base de datos: [Firebase](https://firebase.google.com)
