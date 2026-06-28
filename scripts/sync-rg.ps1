<#
  sync-rg.ps1
  Sincroniza centros de ResponseGrid → Firebase RTDB (/rg_centros)

  Uso:
    cd "ACOPIO VE\scripts"
    .\sync-rg.ps1
#>

$FIREBASE_DB  = "https://acopio-ve-2026-default-rtdb.firebaseio.com"
$RG_BASE      = "https://api.responsegrid.app"
$RG_EMERGENCY = "11111111-1111-4111-8111-111111111111"
$LIMIT        = 100

$CITY_ESTADO = @{
  "Caracas"                = "Distrito Capital"
  "Barquisimeto"           = "Lara"
  "Cabudare"               = "Lara"
  "Quibor"                 = "Lara"
  "Maracay"                = "Aragua"
  "La Victoria"            = "Aragua"
  "Turmero"                = "Aragua"
  "Cagua"                  = "Aragua"
  "Villa de Cura"          = "Aragua"
  "Valencia"               = "Carabobo"
  "San Diego"              = "Carabobo"
  "Naguanagua"             = "Carabobo"
  "Maracaibo"              = "Zulia"
  "Ciudad Ojeda"           = "Zulia"
  "Cabimas"                = "Zulia"
  "Maturin"                = "Monagas"
  "Merida"                 = "Merida"
  "Mérida"                 = "Mérida"
  "Ejido"                  = "Mérida"
  "El Vigia"               = "Mérida"
  "Barcelona"              = "Anzoátegui"
  "Puerto La Cruz"         = "Anzoátegui"
  "Lecheria"               = "Anzoátegui"
  "El Tigre"               = "Anzoátegui"
  "San Cristobal"          = "Táchira"
  "San Cristóbal"          = "Táchira"
  "Tariba"                 = "Táchira"
  "Rubio"                  = "Táchira"
  "Ciudad Bolivar"         = "Bolívar"
  "Ciudad Bolívar"         = "Bolívar"
  "Puerto Ordaz"           = "Bolívar"
  "San Felix"              = "Bolívar"
  "San Félix"              = "Bolívar"
  "Upata"                  = "Bolívar"
  "Coro"                   = "Falcón"
  "Punto Fijo"             = "Falcón"
  "San Juan de los Morros" = "Guárico"
  "Valle de la Pascua"     = "Guárico"
  "Calabozo"               = "Guárico"
  "Guarenas"               = "Miranda"
  "Guatire"                = "Miranda"
  "Los Teques"             = "Miranda"
  "San Antonio de los Altos" = "Miranda"
  "Charallave"             = "Miranda"
  "Cua"                    = "Miranda"
  "Cúa"                    = "Miranda"
  "Ocumare del Tuy"        = "Miranda"
  "Petare"                 = "Miranda"
  "San Felipe"             = "Yaracuy"
  "Chivacoa"               = "Yaracuy"
  "Valera"                 = "Trujillo"
  "Trujillo"               = "Trujillo"
  "Cumana"                 = "Sucre"
  "Cumaná"                 = "Sucre"
  "Carupano"               = "Sucre"
  "Carúpano"               = "Sucre"
  "Porlamar"               = "Nueva Esparta"
  "La Asuncion"            = "Nueva Esparta"
  "La Asunción"            = "Nueva Esparta"
  "Juan Griego"            = "Nueva Esparta"
  "Barinas"                = "Barinas"
  "Tucupita"               = "Delta Amacuro"
  "San Fernando de Apure"  = "Apure"
  "Guanare"                = "Portuguesa"
  "Acarigua"               = "Portuguesa"
  "San Carlos"             = "Cojedes"
  "Puerto Ayacucho"        = "Amazonas"
  "La Guaira"              = "La Guaira (Vargas)"
  "Macuto"                 = "La Guaira (Vargas)"
  "Catia La Mar"           = "La Guaira (Vargas)"
}

$ACCEPTS_ES = @{
  "food"                   = "Alimentos no perecederos"
  "water"                  = "Agua potable"
  "clothing"               = "Ropa y calzado"
  "medicine"               = "Medicamentos"
  "hygiene"                = "Artículos de higiene"
  "blankets"               = "Frazadas y colchonetas"
  "construction_materials" = "Materiales de construcción"
  "medical_equipment"      = "Equipos médicos"
  "tools"                  = "Herramientas"
  "fuel"                   = "Combustible"
  "baby_supplies"          = "Artículos para bebés"
  "mobility_aids"          = "Sillas de ruedas / movilidad"
  "lighting"               = "Linternas / velas"
  "other"                  = "Otros"
}

function Str($val) { if ($null -eq $val) { "" } else { [string]$val } }

function Map-RGItem($item) {
  $city    = Str $item.city
  $estado  = if ($city -and $CITY_ESTADO.ContainsKey($city)) { $CITY_ESTADO[$city] } else { "" }
  $insumos = @($item.accepts | ForEach-Object { $k = Str $_; if ($k -and $ACCEPTS_ES.ContainsKey($k)) { $ACCEPTS_ES[$k] } } | Where-Object { $_ })
  $ts      = if ($item.externalUpdatedAt) { [DateTimeOffset]::Parse($item.externalUpdatedAt).ToUnixTimeMilliseconds() } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $addr    = Str $item.location.address
  $cap     = if ($item.publicStatus -eq "active") { "disponible" } else { "lleno" }
  $verif   = ($item.verificationLevel -eq "verified")

  return [ordered]@{
    id            = Str $item.id
    nombre        = Str $item.name
    estado        = $estado
    municipio     = $city
    direccion     = $addr
    lat           = [double]$item.location.latitude
    lng           = [double]$item.location.longitude
    capacidad     = $cap
    insumos       = $insumos
    contacto      = Str $item.contact
    responsable   = Str $item.manager
    horario       = Str $item.schedule
    verificado    = $verif
    actualizadoEn = [long]$ts
    _source       = "responsegrid"
  }
}

Write-Host "Sincronizando ResponseGrid → Firebase..." -ForegroundColor Cyan

# 1. Fetch all pages from ResponseGrid
$allItems = @()
$page = 1
$totalPages = 1

do {
  Write-Host "  Página $page..." -NoNewline
  $url = "$RG_BASE/emergencies/$RG_EMERGENCY/public/resources?page=$page&limit=$LIMIT"
  $resp = Invoke-WebRequest -Uri $url -UseBasicParsing
  $data = $resp.Content | ConvertFrom-Json

  $totalPages = [Math]::Ceiling($data.total / $LIMIT)
  $veItems = $data.items | Where-Object { $_.country -eq "Venezuela" -and $_.type -eq "collection_point" -and $_.location.latitude -and $_.location.longitude }
  $allItems += $veItems
  Write-Host " $($veItems.Count) VE" -ForegroundColor Green

  $page++
} while ($page -le $totalPages)

Write-Host "Total centros Venezuela: $($allItems.Count)" -ForegroundColor Yellow

# 2. Map to Acopio VE schema
$rgCentros = @{}
foreach ($item in $allItems) {
  $mapped = Map-RGItem $item
  $key = $item.id -replace "[^a-zA-Z0-9_-]", "_"  # Firebase key safe
  $rgCentros[$key] = $mapped
}

# 3. PUT to Firebase RTDB via curl.exe (evita problemas de encoding de PowerShell)
Write-Host "Escribiendo en Firebase RTDB (/rg_centros)..." -ForegroundColor Cyan
$json = $rgCentros | ConvertTo-Json -Depth 10 -Compress
$tmpFile = "$env:TEMP\acopio_rg_sync.json"
Write-Host "JSON: $([Math]::Round($json.Length / 1024, 1)) KB, $($allItems.Count) centros"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tmpFile, $json, $utf8NoBom)  # reescribir sin BOM

$curlOut = & curl.exe -s -o - -w "%{http_code}" -X PUT "$FIREBASE_DB/rg_centros.json" -H "Content-Type: application/json" --data-binary "@$tmpFile" 2>&1
$httpCode = $curlOut[-1]

if ($httpCode -eq "200") {
  Write-Host "OK - $($allItems.Count) centros en Firebase." -ForegroundColor Green
} else {
  Write-Host "HTTP $httpCode" -ForegroundColor Red
  Write-Host ($curlOut[0..($curlOut.Length - 2)] -join "")
}
Remove-Item $tmpFile -ErrorAction SilentlyContinue
