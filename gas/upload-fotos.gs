/**
 * ACOPIO VE — Apps Script: subir fotos a Google Drive
 *
 * INSTRUCCIONES DE DESPLIEGUE:
 * 1. Ve a https://script.google.com → Nuevo proyecto
 * 2. Pega este código (reemplaza todo el contenido)
 * 3. Cambia FOLDER_ID por el ID de tu carpeta de Drive
 *    (el ID está en la URL de la carpeta: drive.google.com/drive/folders/ESTE_ES_EL_ID)
 * 4. Haz clic en "Desplegar" → "Nueva implementación"
 *    - Tipo: App web
 *    - Ejecutar como: Yo (tu cuenta)
 *    - Quién tiene acceso: Cualquiera
 * 5. Copia la URL de la implementación y pégala en config.js → DRIVE_UPLOAD_URL
 */

const FOLDER_ID = "TU_FOLDER_ID_AQUI"; // ← CAMBIA ESTO

function doPost(e) {
  try {
    const payload  = JSON.parse(e.postData.contents);
    const { base64, mimeType, filename, centroId } = payload;

    if (!base64 || !mimeType || !filename) {
      return jsonResponse({ success: false, error: "Faltan campos requeridos" });
    }

    const folder = DriveApp.getFolderById(FOLDER_ID);
    const blob   = Utilities.newBlob(Utilities.base64Decode(base64), mimeType, filename);
    const file   = folder.createFile(blob);

    // Compartir con cualquiera que tenga el enlace (solo vista)
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const fileId = file.getId();

    return jsonResponse({
      success: true,
      fileId,
      url: "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w800"
    });

  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Test desde el editor (ejecuta esto para verificar que el folder ID es correcto)
function testAcceso() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  Logger.log("Carpeta encontrada: " + folder.getName());
}
