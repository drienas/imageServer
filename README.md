# Image Server

Ein hochperformanter Bildserver mit integriertem Caching-System, Bildverarbeitung und verschiedenen Branding-Optionen.

## Endpunkte

### Status-Endpunkte

#### `GET /images/v1/status/:vin`

Liefert Informationen über verfügbare Bilder für ein Fahrzeug.

**Parameter:**

- `vin`: 17-stellige Fahrzeug-Identifikationsnummer

**Beispiel-Antwort:**

```json
{
  "success": true,
  "found": true,
  "images": [
    "/VF1RFB00270131313/1",
    "/VF1RFB00270131313/2",
    "/VF1RFB00270131313/3"
  ],
  "photofairy": false,
  "createdAt": "2024-02-20T10:00:00.000Z",
  "updatedAt": "2024-02-20T10:00:00.000Z"
}
```

#### `GET /images/v1/status/changedsince/:seconds`

Liefert eine Liste von VINs, die in den letzten X Sekunden erstellt oder aktualisiert wurden.

**Parameter:**

- `seconds`: Zeitraum in Sekunden

**Rückgabe:**

- Kombinierte und deduplizierte Liste aller VINs, die entweder neu erstellt oder aktualisiert wurden
- Prüft sowohl `created_at` als auch `updated_at` Zeitstempel
- Cache-Dauer: 60 Sekunden

**Beispiel:**

```
GET /images/v1/status/changedsince/3600  // Änderungen der letzten Stunde

Antwort:
{
  "success": true,
  "data": ["VF1RFB00270131313", "WDD1234567890123"]
}
```

### Bild-Endpunkte

#### `GET /images/v1/raw/:vin/:positionIdentifier`

Liefert das Originalbild ohne Branding.

**Parameter:**

- `vin`: 17-stellige VIN
- `positionIdentifier`: Bildposition (1-n)
- `shrink` (optional): Zielbreite in Pixeln

**Beispiel:**

```
GET /images/v1/raw/VF1RFB00270131313/1?shrink=800
```

#### `GET /images/v1/brand/:vin/:positionIdentifier`

Liefert das Bild mit Standard-Branding.

**Parameter:**

- Wie bei raw-Endpunkt
- Branding wird automatisch auf Position 1 angewendet

#### `GET /images/v2/brand/:brandId/:vin/:positionIdentifier`

Liefert das Bild mit spezifischem Branding.

**Parameter:**

- `brandId`: BRAND, BRANDDSG, BRANDAPPROVED, BRANDBOR
- Weitere Parameter wie bei raw-Endpunkt

**Beispiel:**

```
GET /images/v2/brand/BRANDDSG/VF1RFB00270131313/1?shrink=400
```

### Verwaltungs-Endpunkte

#### `GET /images/v1/link/:from/:to`

Verknüpft Bilder von einer VIN mit einer anderen.

**Parameter:**

- `from`: Quell-VIN
- `to`: Ziel-VIN

#### `DELETE /images/v1/link/:vin`

Löscht eine Bildverknüpfung (nur verlinkte Bilder).

#### `DELETE /images/v1/original/:vin`

Löscht Originalbilder (Basic Auth erforderlich).

## Caching-Mechanismus

Der Server verwendet einen mehrstufigen Cache:

1. **Originalbild-Cache**

   - Key-Format: `img:${vin}:${positionIdentifier}`
   - TTL: 30 Minuten
   - Wird beim ersten Abruf befüllt

2. **Verarbeitete-Bild-Cache**

   - Key-Format: `brand:${brandId}:${vin}:${positionIdentifier}:${shrink}`
   - Speichert bereits verarbeitete Versionen (Größenänderung + Branding)
   - Verhindert wiederholte Bildverarbeitung

3. **Status-Cache**
   - Key-Format: `status:${vin}` für Bildstatus
   - Key-Format: `changedsince:${seconds}` für Änderungsabfragen
   - Kurze TTL für Änderungsabfragen (60 Sekunden)

Cache-Invalidierung:

- Automatische Invalidierung durch TTL
- Manuelle Invalidierung bei Löschoperationen
- Pattern-basierte Invalidierung (z.B. alle Einträge einer VIN)

## Datenstruktur

### Supabase Tabellen

#### Cars

```sql
CREATE TABLE cars (
  vin TEXT PRIMARY KEY,
  images JSONB,
  linked BOOLEAN,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE
);
```

#### Images-Array-Struktur

```json
{
  "positionIdentifier": 1,
  "fileName": "VIN_1.jpg"
}
```

### Dateispeicher

#### Supabase Storage

- Bucket-Struktur: `${vin}/${positionIdentifier}.jpg`
- Originaldateien werden im JPEG-Format gespeichert

#### Lokaler Fallback-Speicher

- Verzeichnisstruktur: `own/${vin}/`
- Dateinamen-Format: `${vin}_${positionIdentifier}.jpg`

### Branding-Assets

- Vorgeladene Buffer für verschiedene Branding-Varianten
- Werden beim Serverstart geladen
- Gleiche Basis-Datei mit unterschiedlichen Verwendungszwecken
